// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthorizationError, DomainError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import type { GoogleOAuthClient } from "./google-oauth";
import { getGoogleSyncSummary, listGoogleSyncContactIds } from "./google-sync-contacts";
import { completeGoogleAuthorization, saveGoogleClient } from "./service";

const { contacts, externalConnections, organizations } = schema;

const ORIGINAL_KEY = process.env.CHANNEL_CREDENTIALS_KEY;
const REDIRECT = "https://app.test/api/integrations/google/callback";

let db: Database;
let orgId: string;
let otherOrgId: string;

const ctx = (role: TenantContext["role"], organizationId = orgId): TenantContext => ({
  organizationId,
  userId: "user-1",
  role,
  isPlatformAdmin: false,
});

const oauth: GoogleOAuthClient = {
  buildAuthUrl: ({ state }) => `https://accounts.google.test/auth?state=${state}`,
  exchangeCode: () =>
    Promise.resolve({
      tokens: {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      accountEmail: "owner@acme.test",
    }),
  refreshAccessToken: () => Promise.reject(new Error("not expected")),
  revokeToken: () => Promise.resolve(),
};

// RLS applies to the test connection too: deletes must run inside the tenant.
const clearOrg = (organizationId: string) =>
  withTenant(db, organizationId, async (tx) => {
    await tx
      .delete(externalConnections)
      .where(eq(externalConnections.organizationId, organizationId));
    await tx.delete(contacts).where(eq(contacts.organizationId, organizationId));
  });

async function connect() {
  const admin = ctx("admin");
  const { authUrl } = await saveGoogleClient(
    db,
    admin,
    { clientId: "client-id-123", clientSecret: "client-secret-456", redirectUri: REDIRECT },
    oauth,
  );
  await completeGoogleAuthorization(
    db,
    admin,
    { code: "code", state: new URL(authUrl).searchParams.get("state")!, redirectUri: REDIRECT },
    oauth,
  );
}

async function addContact(
  organizationId: string,
  channelUserId: string,
  metadata: Record<string, unknown> = {},
) {
  const [row] = await withTenant(db, organizationId, (tx) =>
    tx
      .insert(contacts)
      .values({ organizationId, channelUserId, displayName: "X", metadata })
      .returning({ id: contacts.id }),
  );
  return row!.id;
}

beforeAll(async () => {
  process.env.CHANNEL_CREDENTIALS_KEY = "b".repeat(64);
  db = createDb(getServerEnv().database.url);
  try {
    await db.execute(sql`select 1`);
  } catch (error) {
    throw new Error(
      "Integration tests require a migrated database. Run `pnpm infra:up && pnpm db:migrate` first.",
      { cause: error },
    );
  }
  const suffix = crypto.randomUUID().slice(0, 8);
  const orgs = await db
    .insert(organizations)
    .values([
      { name: "GList IT A", slug: `glist-a-${suffix}` },
      { name: "GList IT B", slug: `glist-b-${suffix}` },
    ])
    .returning({ id: organizations.id });
  orgId = orgs[0]!.id;
  otherOrgId = orgs[1]!.id;
}, 60_000);

afterAll(async () => {
  process.env.CHANNEL_CREDENTIALS_KEY = ORIGINAL_KEY;
  await db.delete(organizations).where(sql`${organizations.id} in (${orgId}, ${otherOrgId})`);
  await db.$client.end();
});

beforeEach(async () => {
  await clearOrg(orgId);
});

describe("getGoogleSyncSummary", () => {
  it("counts eligible and synced contacts and reports the latest sync, per organization", async () => {
    await addContact(orgId, "5511999990001@c.us");
    await addContact(orgId, "5511999990002@c.us", {
      google: { resourceName: "people/c1", lastSyncedAt: "2026-10-01T10:00:00.000Z" },
    });
    await addContact(orgId, "site:visitor-1", { email: "a@acme.test" });
    await addContact(orgId, "site:visitor-2"); // ineligible: no phone, no e-mail
    await addContact(orgId, "123@lid"); // ineligible: opaque id
    await addContact(otherOrgId, "5511999990009@c.us");

    expect(await getGoogleSyncSummary(db, ctx("viewer"))).toEqual({
      eligible: 3,
      synced: 1,
      lastSyncedAt: "2026-10-01T10:00:00.000Z",
    });
    await clearOrg(otherOrgId);
  });

  it("is empty for an organization without contacts", async () => {
    expect(await getGoogleSyncSummary(db, ctx("admin"))).toEqual({
      eligible: 0,
      synced: 0,
      lastSyncedAt: null,
    });
  });
});

describe("listGoogleSyncContactIds", () => {
  it("requires integrations:manage", async () => {
    await connect();
    await expect(listGoogleSyncContactIds(db, ctx("viewer"), { limit: 10 })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("refuses when Google is not connected", async () => {
    await expect(listGoogleSyncContactIds(db, ctx("admin"), { limit: 10 })).rejects.toBeInstanceOf(
      DomainError,
    );
  });

  it("pages through only the eligible contacts of the organization", async () => {
    await connect();
    const eligible = [
      await addContact(orgId, "5511999990011@c.us"),
      await addContact(orgId, "5511999990012@c.us"),
      await addContact(orgId, "5511999990013@c.us"),
    ];
    await addContact(orgId, "site:visitor-3"); // ineligible
    await addContact(otherOrgId, "5511999990019@c.us");

    const seen: string[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await listGoogleSyncContactIds(db, ctx("admin"), { limit: 2, after });
      seen.push(...page.ids);
      if (!page.next) break;
      after = page.next;
    }
    expect(seen.sort()).toEqual([...eligible].sort());
    await clearOrg(otherOrgId);
  });
});
