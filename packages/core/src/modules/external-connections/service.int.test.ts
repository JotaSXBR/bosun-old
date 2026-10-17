// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError, DomainError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import type { GoogleOAuthClient } from "./google-oauth";
import { GoogleOAuthError } from "./google-oauth";
import {
  completeGoogleAuthorization,
  disconnectGoogle,
  getGoogleAccessToken,
  getGoogleStatus,
  saveGoogleClient,
  verifyGoogleConnection,
} from "./service";

const { externalConnections, organizations } = schema;

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
const agentA = () => ctx(orgA, "agent");
const viewerA = () => ctx(orgA, "viewer");
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

describe("google connection", () => {
  it("walks pending → connected → needs_reauth → disconnected without leaking secrets", async () => {
    const oauth = fakeOAuth();
    const { authUrl } = await saveGoogleClient(db, adminA(), input, oauth);
    expect((await getGoogleStatus(db, viewerA()))?.status).toBe("pending");

    const connected = await completeGoogleAuthorization(
      db,
      adminA(),
      { code: "code", state: stateOf(authUrl), redirectUri: REDIRECT },
      oauth,
    );
    expect(connected.status).toBe("connected");
    expect(connected.accountEmail).toBe("owner@acme.test");
    expect(JSON.stringify(connected)).not.toMatch(/secret|access-1|refresh-1|bundle/i);

    const verified = await verifyGoogleConnection(db, adminA(), oauth);
    expect(verified.status).toBe("connected");
    expect(verified.lastCheckedAt).not.toBeNull();

    const revoked = fakeOAuth({
      refreshAccessToken: () => Promise.reject(new GoogleOAuthError("invalid_grant")),
    });
    const needsReauth = await verifyGoogleConnection(db, adminA(), revoked);
    expect(needsReauth.status).toBe("needs_reauth");
    expect(needsReauth.lastError).toBe("invalid_grant");

    await disconnectGoogle(db, adminA());
    expect(await getGoogleStatus(db, adminA())).toBeNull();
  });

  it("revokes the refresh token at Google on disconnect, even if revoking fails", async () => {
    const revoked: string[] = [];
    const oauth = fakeOAuth({
      revokeToken: ({ token }) => {
        revoked.push(token);
        return Promise.resolve();
      },
    });
    const { authUrl } = await saveGoogleClient(db, adminA(), input, oauth);
    await completeGoogleAuthorization(
      db,
      adminA(),
      { code: "code", state: stateOf(authUrl), redirectUri: REDIRECT },
      oauth,
    );
    await disconnectGoogle(db, adminA(), oauth);
    expect(revoked).toEqual(["refresh-1"]);
    expect(await getGoogleStatus(db, adminA())).toBeNull();

    const failing = fakeOAuth({
      revokeToken: () => Promise.reject(new GoogleOAuthError("network")),
    });
    const second = await saveGoogleClient(db, adminA(), input, failing);
    await completeGoogleAuthorization(
      db,
      adminA(),
      { code: "code", state: stateOf(second.authUrl), redirectUri: REDIRECT },
      failing,
    );
    await disconnectGoogle(db, adminA(), failing);
    expect(await getGoogleStatus(db, adminA())).toBeNull();
  });

  it("does not try to revoke a connection that never got tokens", async () => {
    const revoked: string[] = [];
    const oauth = fakeOAuth({
      revokeToken: ({ token }) => {
        revoked.push(token);
        return Promise.resolve();
      },
    });
    await saveGoogleClient(db, adminA(), input, oauth);
    await disconnectGoogle(db, adminA(), oauth);
    expect(revoked).toEqual([]);
  });

  it("marks the connection as error (not needs_reauth) on a non-invalid_grant refresh failure", async () => {
    const oauth = fakeOAuth();
    const { authUrl } = await saveGoogleClient(db, adminA(), input, oauth);
    await completeGoogleAuthorization(
      db,
      adminA(),
      { code: "code", state: stateOf(authUrl), redirectUri: REDIRECT },
      oauth,
    );
    const flaky = fakeOAuth({
      refreshAccessToken: () => Promise.reject(new GoogleOAuthError("temporarily_unavailable")),
    });
    const result = await verifyGoogleConnection(db, adminA(), flaky);
    expect(result.status).toBe("error");
    expect(result.lastError).toBe("temporarily_unavailable");
    await disconnectGoogle(db, adminA(), oauth);
  });

  it("stores the bundle encrypted at rest", async () => {
    await saveGoogleClient(db, adminA(), input, fakeOAuth());
    const [row] = await withTenant(db, orgA, (tx) =>
      tx.select().from(externalConnections).where(eq(externalConnections.provider, "google")),
    );
    expect(row!.bundleEncrypted.startsWith("v1.")).toBe(true);
    expect(row!.bundleEncrypted).not.toContain("client-secret-456");
    await disconnectGoogle(db, adminA());
  });

  it("rejects a wrong, missing or reused state without storing tokens", async () => {
    const oauth = fakeOAuth();
    const { authUrl } = await saveGoogleClient(db, adminA(), input, oauth);
    const bad = completeGoogleAuthorization(
      db,
      adminA(),
      { code: "code", state: "forged", redirectUri: REDIRECT },
      oauth,
    );
    await expect(bad).rejects.toMatchObject({ code: "GOOGLE_STATE_INVALID" });
    expect((await getGoogleStatus(db, adminA()))?.status).toBe("pending");

    await completeGoogleAuthorization(
      db,
      adminA(),
      { code: "code", state: stateOf(authUrl), redirectUri: REDIRECT },
      oauth,
    );
    const reused = completeGoogleAuthorization(
      db,
      adminA(),
      { code: "code", state: stateOf(authUrl), redirectUri: REDIRECT },
      oauth,
    );
    await expect(reused).rejects.toMatchObject({ code: "GOOGLE_STATE_INVALID" });
    await disconnectGoogle(db, adminA());
  });

  it("marks the connection as error when the code exchange fails", async () => {
    const failing = fakeOAuth({
      exchangeCode: () => Promise.reject(new GoogleOAuthError("invalid_client")),
    });
    const { authUrl } = await saveGoogleClient(db, adminA(), input, failing);
    const error = await completeGoogleAuthorization(
      db,
      adminA(),
      { code: "code", state: stateOf(authUrl), redirectUri: REDIRECT },
      failing,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    const status = await getGoogleStatus(db, adminA());
    expect(status?.status).toBe("error");
    expect(status?.lastError).toBe("invalid_client");
    await disconnectGoogle(db, adminA());
  });

  it("requires integrations:manage to change and integrations:read to view", async () => {
    await expect(saveGoogleClient(db, agentA(), input, fakeOAuth())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(verifyGoogleConnection(db, viewerA(), fakeOAuth())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(disconnectGoogle(db, agentA())).rejects.toBeInstanceOf(AuthorizationError);
    expect(await getGoogleStatus(db, viewerA())).toBeNull();
  });

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
      const { authUrl } = await saveGoogleClient(db, adminA(), input, oauth);
      await completeGoogleAuthorization(
        db,
        adminA(),
        { code: "code", state: stateOf(authUrl), redirectUri: REDIRECT },
        oauth,
      );
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
      await saveGoogleClient(db, adminA(), input, fakeOAuth());
      expect(await getGoogleAccessToken(db, orgA, fakeOAuth())).toBeNull();
      await disconnectGoogle(db, adminA());
    });
  });

  it("keeps each org's connection isolated", async () => {
    await saveGoogleClient(db, adminA(), input, fakeOAuth());
    expect(await getGoogleStatus(db, adminB())).toBeNull();
    await disconnectGoogle(db, adminA());
  });
});
