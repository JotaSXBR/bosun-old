// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { TenantContext } from "@crm/core";
import { getGoogleStatus, saveGoogleClient } from "@crm/core/external-connections";
import type { Database } from "@crm/db";
import { createDb, schema } from "@crm/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { getTenantContext } from "@/server/tenant";

import { googleRedirectUri } from "../redirect";
import { GET } from "./route";

vi.mock("@/server/tenant", () => ({ getTenantContext: vi.fn() }));

const { organizations } = schema;
const ORIGINAL_KEY = process.env.CHANNEL_CREDENTIALS_KEY;
const CONTACTS = "https://www.googleapis.com/auth/contacts";

let db: Database;
let orgId: string;

const tenant = (role: TenantContext["role"]): TenantContext => ({
  organizationId: orgId,
  userId: "user-1",
  role,
  isPlatformAdmin: false,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubGoogle(tokenBody: unknown = null) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      return Promise.resolve(
        url.includes("userinfo")
          ? json({ email: "owner@acme.test" })
          : json(
              tokenBody ?? {
                access_token: "at",
                refresh_token: "rt",
                expires_in: 3600,
                scope: `openid ${CONTACTS}`,
              },
            ),
      );
    }),
  );
}

/** Starts a consent for the test org and returns its anti-CSRF state. */
async function startConsent(): Promise<string> {
  const { authUrl } = await saveGoogleClient(db, tenant("admin"), {
    input: {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: googleRedirectUri(),
    },
  });
  return new URL(authUrl).searchParams.get("state")!;
}

const callback = (query: Record<string, string>) =>
  GET(
    new Request(
      `http://localhost:3000/api/integrations/google/callback?${new URLSearchParams(query)}`,
    ),
  );

const outcome = (response: Response) => new URL(response.headers.get("location")!);

beforeAll(async () => {
  process.env.CHANNEL_CREDENTIALS_KEY = "c".repeat(64);
  db = createDb(getServerEnv().database.url);
  const [org] = await db
    .insert(organizations)
    .values({ name: "Google CB IT", slug: `google-cb-${crypto.randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  orgId = org!.id;
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(getTenantContext).mockReset();
});

afterAll(async () => {
  process.env.CHANNEL_CREDENTIALS_KEY = ORIGINAL_KEY;
  await db.delete(organizations).where(sql`${organizations.id} = ${orgId}`);
  await db.$client.end();
});

describe("GET /api/integrations/google/callback", () => {
  it("sends an unauthenticated visitor to sign-in without touching Google", async () => {
    vi.mocked(getTenantContext).mockResolvedValue(null);
    stubGoogle();
    const response = await callback({ code: "c", state: "s" });
    expect(response.status).toBe(302);
    expect(outcome(response).pathname).toBe("/sign-in");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports access_denied without consuming the pending state", async () => {
    vi.mocked(getTenantContext).mockResolvedValue(tenant("admin"));
    const state = await startConsent();
    const response = await callback({ error: "access_denied", state });
    expect(outcome(response).searchParams.get("google")).toBe("denied");
    expect((await getGoogleStatus(db, tenant("admin")))?.status).toBe("pending");
  });

  it("rejects a forged state and keeps the connection pending", async () => {
    vi.mocked(getTenantContext).mockResolvedValue(tenant("admin"));
    await startConsent();
    stubGoogle();
    const response = await callback({ code: "c", state: "forged" });
    expect(outcome(response).searchParams.get("google")).toBe("state");
    expect(fetch).not.toHaveBeenCalled();
    expect((await getGoogleStatus(db, tenant("admin")))?.status).toBe("pending");
  });

  it("refuses a member without integrations:manage", async () => {
    vi.mocked(getTenantContext).mockResolvedValue(tenant("agent"));
    const response = await callback({ code: "c", state: "s" });
    expect(outcome(response).searchParams.get("google")).toBe("forbidden");
  });

  it("connects the account when the state matches, and never caches or leaks the code", async () => {
    vi.mocked(getTenantContext).mockResolvedValue(tenant("admin"));
    const state = await startConsent();
    stubGoogle();
    const response = await callback({ code: "auth-code", state });
    expect(response.status).toBe(302);
    expect(outcome(response).pathname).toBe("/app/settings/channels");
    expect(outcome(response).searchParams.get("google")).toBe("ok");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).not.toContain("auth-code");
    const status = await getGoogleStatus(db, tenant("admin"));
    expect(status?.status).toBe("connected");
    expect(status?.accountEmail).toBe("owner@acme.test");
  });

  it("reports failure when the user unticked the contacts scope", async () => {
    vi.mocked(getTenantContext).mockResolvedValue(tenant("admin"));
    const state = await startConsent();
    stubGoogle({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "openid" });
    const response = await callback({ code: "c", state });
    expect(outcome(response).searchParams.get("google")).toBe("failed");
    expect((await getGoogleStatus(db, tenant("admin")))?.status).toBe("error");
  });
});
