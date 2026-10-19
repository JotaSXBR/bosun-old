// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import type { Database } from "@crm/db";
import { schema, withPlatformScope } from "@crm/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { decryptJson } from "../../lib/crypto";
import type { TenantContext } from "../../tenant/context";
import { setPlatformSetting } from "../platform";
import { createChannelConnection } from "./service";
import type { Stub } from "./service.fixture";
import { useIntegrationsFixture } from "./service.fixture";

const fx = useIntegrationsFixture();
const { ctx, createWahaConnection } = fx;

let db: Database;
let stub: Stub;

// Runs after the fixture's own hooks, which create them.
beforeAll(() => {
  db = fx.db();
  stub = fx.stub();
});

describe("createChannelConnection", () => {
  it("derives the WAHA session name from the connection name", async () => {
    const conn = await createWahaConnection(stub.url, "Motorola Edge 60");
    const credentials = decryptJson<{ session?: string }>(conn.credentialsEncrypted);
    expect(credentials.session).toMatch(/^motorola-edge-60-[0-9a-f]{8}$/);
  });

  it("gives same-named connections distinct sessions (no webhook cross-wiring)", async () => {
    const [a, b] = await Promise.all([
      createWahaConnection(stub.url, "IT WAHA"),
      createWahaConnection(stub.url, "IT WAHA"),
    ]);
    const credsA = decryptJson<{ session?: string }>(a.credentialsEncrypted);
    const credsB = decryptJson<{ session?: string }>(b.credentialsEncrypted);
    expect(credsA.session).not.toBe(credsB.session);
  });

  it("falls back to conn_* when the name has no slug-able characters", async () => {
    const conn = await createWahaConnection(stub.url, "!!!");
    const credentials = decryptJson<{ session?: string }>(conn.credentialsEncrypted);
    expect(credentials.session).toMatch(/^conn_[0-9a-f]{16}$/);
  });

  it("generates a distinct webhook HMAC key per connection", async () => {
    const [a, b] = await Promise.all([
      createWahaConnection(stub.url),
      createWahaConnection(stub.url),
    ]);
    const credsA = decryptJson<{ webhookHmacKey?: string }>(a.credentialsEncrypted);
    const credsB = decryptJson<{ webhookHmacKey?: string }>(b.credentialsEncrypted);
    expect(credsA.webhookHmacKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(credsB.webhookHmacKey).not.toBe(credsA.webhookHmacKey);
  });

  it("snapshots platform envs as the connection credentials", async () => {
    const conn = await createWahaConnection(stub.url);
    const credentials = decryptJson<{ baseUrl?: string; apiKey?: string }>(
      conn.credentialsEncrypted,
    );
    expect(credentials.baseUrl).toBe(stub.url);
    expect(credentials.apiKey).toBe("it-key");
  });

  it("fails with WAHA_NOT_CONFIGURED when the platform envs are absent", async () => {
    delete process.env.WAHA_BASE_URL;
    await expect(
      createChannelConnection(db, ctx("owner"), { kind: "waha", name: "x" }),
    ).rejects.toThrow(/não está configurado/);
  });

  const adminCtx = (): TenantContext => ({ ...ctx("owner"), isPlatformAdmin: true });
  const cleanMeta = () =>
    withPlatformScope(db, (tx) =>
      tx.delete(schema.platformSettings).where(eq(schema.platformSettings.key, "meta")),
    );

  it("meta connection fills app-level secrets from platform_settings", async () => {
    await setPlatformSetting(db, adminCtx(), {
      group: "meta",
      input: {
        appSecret: `meta_secret_${Date.now()}`,
        verifyToken: "meta_verify_it",
        graphApiVersion: "v99.0",
      },
    });
    try {
      const conn = await createChannelConnection(db, ctx("owner"), {
        kind: "meta_cloud",
        name: "Meta IT",
        credentials: { phoneNumberId: "pn_it", accessToken: "at_it" },
      });
      const credentials = decryptJson<Record<string, string>>(conn.credentialsEncrypted);
      expect(credentials.phoneNumberId).toBe("pn_it");
      expect(credentials.accessToken).toBe("at_it");
      expect(credentials.appSecret).toContain("meta_secret_");
      expect(credentials.verifyToken).toBe("meta_verify_it");
      expect(credentials.graphApiVersion).toBe("v99.0");
    } finally {
      await cleanMeta();
    }
  });

  it("connection-supplied meta secrets win over platform defaults", async () => {
    await setPlatformSetting(db, adminCtx(), {
      group: "meta",
      input: {
        appSecret: "platform_secret",
        verifyToken: "platform_verify",
      },
    });
    try {
      const conn = await createChannelConnection(db, ctx("owner"), {
        kind: "meta_cloud",
        name: "Meta IT explicit",
        credentials: {
          phoneNumberId: "pn_it2",
          accessToken: "at_it2",
          appSecret: "conn_secret",
          verifyToken: "conn_verify",
        },
      });
      const credentials = decryptJson<Record<string, string>>(conn.credentialsEncrypted);
      expect(credentials.appSecret).toBe("conn_secret");
      expect(credentials.verifyToken).toBe("conn_verify");
    } finally {
      await cleanMeta();
    }
  });

  it("rejects meta connection when secrets are missing from input and platform", async () => {
    await cleanMeta();
    await expect(
      createChannelConnection(db, ctx("owner"), {
        kind: "meta_cloud",
        name: "Meta IT no secrets",
        credentials: { phoneNumberId: "pn_it3", accessToken: "at_it3" },
      }),
    ).rejects.toThrow(/META_CREDENTIALS_INCOMPLETE|incompletas/);
  });
});
