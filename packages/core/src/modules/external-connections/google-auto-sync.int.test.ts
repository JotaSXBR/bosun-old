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
import {
  completeGoogleAuthorization,
  disconnectGoogle,
  enableGoogleAutoSync,
  isGoogleAutoSyncActive,
  markGoogleSweepAt,
  saveGoogleClient,
} from "./service";

const { externalConnections, organizations } = schema;

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

const clearOrg = (organizationId: string) =>
  withTenant(db, organizationId, (tx) =>
    tx.delete(externalConnections).where(eq(externalConnections.organizationId, organizationId)),
  );

async function connect(organizationId = orgId) {
  const admin = ctx("admin", organizationId);
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

const readRow = (organizationId: string) =>
  withTenant(db, organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(externalConnections)
      .where(eq(externalConnections.organizationId, organizationId));
    return row;
  });

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
      { name: "GAuto IT A", slug: `gauto-a-${suffix}` },
      { name: "GAuto IT B", slug: `gauto-b-${suffix}` },
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
  await clearOrg(otherOrgId);
});

describe("google auto-sync consent", () => {
  it("is off until enabled, keeps the original date, and does not leak to another org", async () => {
    await connect();
    await connect(otherOrgId);
    expect(await isGoogleAutoSyncActive(db, orgId)).toBe(false);

    await enableGoogleAutoSync(db, ctx("admin"));
    const first = (await readRow(orgId))!.autoSyncSince;
    await enableGoogleAutoSync(db, ctx("admin"));

    expect(first).not.toBeNull();
    expect((await readRow(orgId))!.autoSyncSince).toEqual(first);
    expect(await isGoogleAutoSyncActive(db, orgId)).toBe(true);
    expect(await isGoogleAutoSyncActive(db, otherOrgId)).toBe(false);
  });

  it("requires manage permission and a connected account", async () => {
    await expect(enableGoogleAutoSync(db, ctx("admin"))).rejects.toBeInstanceOf(DomainError);
    await connect();
    await expect(enableGoogleAutoSync(db, ctx("viewer"))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("is cleared by disconnect and by saving the client again", async () => {
    await connect();
    await enableGoogleAutoSync(db, ctx("admin"));
    await disconnectGoogle(db, ctx("admin"), oauth);
    expect(await isGoogleAutoSyncActive(db, orgId)).toBe(false);

    await connect();
    await enableGoogleAutoSync(db, ctx("admin"));
    await markGoogleSweepAt(db, orgId);
    await connect();
    const row = (await readRow(orgId))!;
    expect(row.autoSyncSince).toBeNull();
    expect(row.lastSweepAt).toBeNull();
  });

  it("stamps the sweep time", async () => {
    await connect();
    await markGoogleSweepAt(db, orgId);
    expect((await readRow(orgId))!.lastSweepAt).not.toBeNull();
  });
});
