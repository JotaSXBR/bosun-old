// Shared setup for the google-contact-sync integration tests (not a test file itself).
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach } from "vitest";

import type { TenantContext } from "../../tenant/context";
import { findContactById } from "../contacts";
import type { GoogleOAuthClient } from "./google-oauth";
import type { GooglePeopleClient, GooglePerson } from "./google-people";
import { completeGoogleAuthorization, enableGoogleAutoSync, saveGoogleClient } from "./service";

const { contacts, externalConnections, organizations } = schema;

const ORIGINAL_KEY = process.env.CHANNEL_CREDENTIALS_KEY;
export const REDIRECT = "https://app.test/api/integrations/google/callback";

export const oauth: GoogleOAuthClient = {
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

export type Calls = string[];

export function fakePeople(
  overrides: Partial<GooglePeopleClient> = {},
  calls: Calls = [],
): GooglePeopleClient {
  const person = (resourceName: string, etag = "etag-1"): GooglePerson => ({
    resourceName,
    source: { type: "CONTACT", id: resourceName.slice(7), etag },
    phones: [],
    emails: [],
  });
  return {
    searchContacts: () => {
      calls.push("search");
      return Promise.resolve([]);
    },
    getContact: ({ resourceName }) => {
      calls.push("get");
      return Promise.resolve(person(resourceName));
    },
    createContact: () => {
      calls.push("create");
      return Promise.resolve(person("people/c1"));
    },
    updateContact: ({ current }) => {
      calls.push("update");
      return Promise.resolve(person(current.resourceName, "etag-2"));
    },
    ...overrides,
  };
}

type State = { db: Database; orgId: string; ctx: TenantContext };

async function setUpOrg(): Promise<State> {
  process.env.CHANNEL_CREDENTIALS_KEY = "b".repeat(64);
  const db = createDb(getServerEnv().database.url);
  try {
    await db.execute(sql`select 1`);
  } catch (error) {
    throw new Error(
      "Integration tests require a migrated database. Run `pnpm infra:up && pnpm db:migrate` first.",
      { cause: error },
    );
  }
  const [org] = await db
    .insert(organizations)
    .values({ name: "GSync IT", slug: `gsync-it-${crypto.randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  const orgId = org!.id;
  const ctx: TenantContext = {
    organizationId: orgId,
    userId: "user-1",
    role: "admin",
    isPlatformAdmin: false,
  };
  return { db, orgId, ctx };
}

async function newContactIn(
  { db, orgId }: State,
  values: { channelUserId: string; displayName: string },
) {
  const [row] = await withTenant(db, orgId, (tx) =>
    tx
      .insert(contacts)
      .values({ organizationId: orgId, ...values })
      .returning({ id: contacts.id }),
  );
  return row!.id;
}

async function connectIn({ db, ctx }: State, consent: boolean) {
  const { authUrl } = await saveGoogleClient(db, ctx, {
    input: { clientId: "client-id-123", clientSecret: "client-secret-456", redirectUri: REDIRECT },
    oauth,
  });
  await completeGoogleAuthorization(db, ctx, {
    input: {
      code: "code",
      state: new URL(authUrl).searchParams.get("state")!,
      redirectUri: REDIRECT,
    },
    oauth,
  });
  if (consent) await enableGoogleAutoSync(db, ctx);
}

/**
 * Registers the org/db hooks and returns accessors plus the contact helpers
 * bound to that org. Call once at the top of a test file.
 */
export function useGoogleSyncFixture() {
  let state: State;

  beforeAll(async () => {
    state = await setUpOrg();
  }, 60_000);

  afterAll(async () => {
    process.env.CHANNEL_CREDENTIALS_KEY = ORIGINAL_KEY;
    await state.db.delete(organizations).where(eq(organizations.id, state.orgId));
    await state.db.$client.end();
  });

  beforeEach(async () => {
    await state.db
      .delete(externalConnections)
      .where(eq(externalConnections.organizationId, state.orgId));
  });

  return {
    db: () => state.db,
    orgId: () => state.orgId,
    ctx: () => state.ctx,
    newContact: (values: { channelUserId: string; displayName: string }) =>
      newContactIn(state, values),
    stored: async (contactId: string) => {
      const row = await withTenant(state.db, state.orgId, (tx) => findContactById(tx, contactId));
      return row!;
    },
    connect: (consent = true) => connectIn(state, consent),
  };
}
