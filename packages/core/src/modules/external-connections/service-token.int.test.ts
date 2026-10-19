// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema } from "@crm/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TenantContext } from "../../tenant/context";
import type { GoogleOAuthClient } from "./google-oauth";
import { GoogleOAuthError } from "./google-oauth";
import {
  completeGoogleAuthorization,
  disconnectGoogle,
  getGoogleAccessToken,
  getGoogleStatus,
  saveGoogleClient,
} from "./service";

const { organizations } = schema;

const ORIGINAL_KEY = process.env.CHANNEL_CREDENTIALS_KEY;
const REDIRECT = "https://app.test/api/integrations/google/callback";

let db: Database;
let orgA: string;
let orgB: string;

const ctx = (organizationId: string, role: TenantContext["role"]): TenantContext => ({
  organizationId,
  userId: "user-1",
  role,
  isPlatformAdmin: false,
});
const adminA = () => ctx(orgA, "admin");
const adminB = () => ctx(orgB, "admin");

function fakeOAuth(overrides: Partial<GoogleOAuthClient> = {}): GoogleOAuthClient {
  return {
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
    refreshAccessToken: () =>
      Promise.resolve({
        accessToken: "access-2",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    revokeToken: () => Promise.resolve(),
    ...overrides,
  };
}

const stateOf = (authUrl: string) => new URL(authUrl).searchParams.get("state")!;

beforeAll(async () => {
  process.env.CHANNEL_CREDENTIALS_KEY = "b".repeat(64);
  const env = getServerEnv();
  db = createDb(env.database.url);
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
      { name: "ExtConn IT A", slug: `ext-it-a-${suffix}` },
      { name: "ExtConn IT B", slug: `ext-it-b-${suffix}` },
    ])
    .returning({ id: organizations.id });
  orgA = orgs[0]!.id;
  orgB = orgs[1]!.id;
}, 60_000);

afterAll(async () => {
  process.env.CHANNEL_CREDENTIALS_KEY = ORIGINAL_KEY;
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.$client.end();
});

const input = {
  clientId: "client-id-123",
  clientSecret: "client-secret-456",
  redirectUri: REDIRECT,
};

describe("google connection — access token", () => {
  describe("getGoogleAccessToken (system path for the sync job)", () => {
    const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

    async function connect(expiresAt?: string) {
      const base = fakeOAuth();
      const oauth = expiresAt
        ? fakeOAuth({
            exchangeCode: async (input) => {
              const result = await base.exchangeCode(input);
              return { ...result, tokens: { ...result.tokens, expiresAt } };
            },
          })
        : base;
      const { authUrl } = await saveGoogleClient(db, adminA(), { input, oauth });
      await completeGoogleAuthorization(db, adminA(), {
        input: { code: "code", state: stateOf(authUrl), redirectUri: REDIRECT },
        oauth,
      });
    }

    it("returns the stored token while it is still valid, without refreshing", async () => {
      await connect();
      let refreshes = 0;
      const oauth = fakeOAuth({
        refreshAccessToken: () => {
          refreshes += 1;
          return Promise.reject(new GoogleOAuthError("should_not_refresh"));
        },
      });
      expect(await getGoogleAccessToken(db, orgA, oauth)).toEqual({ accessToken: "access-1" });
      expect(refreshes).toBe(0);
      await disconnectGoogle(db, adminA());
    });

    it("refreshes an expired token once and persists it", async () => {
      await connect(hourAgo());
      let refreshes = 0;
      const oauth = fakeOAuth({
        refreshAccessToken: () => {
          refreshes += 1;
          return Promise.resolve({
            accessToken: "access-renewed",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          });
        },
      });
      expect(await getGoogleAccessToken(db, orgA, oauth)).toEqual({
        accessToken: "access-renewed",
      });
      expect(await getGoogleAccessToken(db, orgA, oauth)).toEqual({
        accessToken: "access-renewed",
      });
      expect(refreshes).toBe(1);
      await disconnectGoogle(db, adminA());
    });

    it("marks needs_reauth and returns null when Google revoked the grant", async () => {
      await connect(hourAgo());
      const revoked = fakeOAuth({
        refreshAccessToken: () => Promise.reject(new GoogleOAuthError("invalid_grant")),
      });
      expect(await getGoogleAccessToken(db, orgA, revoked)).toBeNull();
      expect((await getGoogleStatus(db, adminA()))?.status).toBe("needs_reauth");
      expect(await getGoogleAccessToken(db, orgA, fakeOAuth())).toBeNull();
      await disconnectGoogle(db, adminA());
    });

    it("keeps the connection and rethrows on a transient refresh failure", async () => {
      await connect(hourAgo());
      const flaky = fakeOAuth({
        refreshAccessToken: () => Promise.reject(new GoogleOAuthError("temporarily_unavailable")),
      });
      await expect(getGoogleAccessToken(db, orgA, flaky)).rejects.toBeInstanceOf(GoogleOAuthError);
      expect((await getGoogleStatus(db, adminA()))?.status).toBe("connected");
      await disconnectGoogle(db, adminA());
    });

    it("returns null when there is no connected account (none, or still pending)", async () => {
      expect(await getGoogleAccessToken(db, orgA, fakeOAuth())).toBeNull();
      await saveGoogleClient(db, adminA(), { input, oauth: fakeOAuth() });
      expect(await getGoogleAccessToken(db, orgA, fakeOAuth())).toBeNull();
      await disconnectGoogle(db, adminA());
    });
  });

  it("keeps each org's connection isolated", async () => {
    await saveGoogleClient(db, adminA(), { input, oauth: fakeOAuth() });
    expect(await getGoogleStatus(db, adminB())).toBeNull();
    await disconnectGoogle(db, adminA());
  });
});
