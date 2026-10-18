// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { createServer, type Server } from "node:http";

import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, sql, withPlatformScope } from "@crm/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decryptJson } from "../../lib/crypto";
import type { TenantContext } from "../../tenant/context";
import { setPlatformSetting } from "../platform";
import {
  createChannelConnection,
  refreshConnectionStatus,
  requestConnectionPairingCode,
} from "./service";

const { organizations, users } = schema;

let db: Database;
let orgId: string;
let userId: string;

const ORIGINAL_KEY = process.env.CHANNEL_CREDENTIALS_KEY;
const ORIGINAL_APP_URL = process.env.APP_URL;
const ORIGINAL_WAHA_BASE_URL = process.env.WAHA_BASE_URL;
const ORIGINAL_WAHA_API_KEY = process.env.WAHA_API_KEY;

function ctx(role: TenantContext["role"]): TenantContext {
  return { organizationId: orgId, userId, role, isPlatformAdmin: false };
}

/**
 * Minimal WAHA stub — records requests and answers the endpoints the
 * adapter's connect flow touches. `sessionStatus` lets each test steer
 * the lifecycle; `requests` is asserted after the run.
 */
type Stub = {
  url: string;
  requests: { method: string; path: string; body?: unknown }[];
  sessionStatus: string;
  /** When set, GET session reports this webhook URL already registered —
   *  mirrors WAHA returning `config.webhooks` in the session response. */
  webhookUrl?: string;
  close: () => Promise<void>;
};

type StubReply = { status: number; value?: unknown; png?: Buffer };

/** /api/sessions/<name>[/<sub>] routes — session names are derived from the
 *  connection name (`<slug>-<hex>`), so they match dynamically. */
function sessionRoute(
  parts: string[],
  method: string,
  { sessionStatus, webhookUrl }: { sessionStatus: string; webhookUrl?: string },
): StubReply {
  const name = parts[2];
  const sub = parts[3];
  if (method === "PUT" && name) return { status: 200, value: {} };
  switch (`${method}:${name ? "id" : "-"}:${sub ?? "-"}`) {
    case "GET:id:-":
      return {
        status: 200,
        value: {
          name,
          status: sessionStatus,
          ...(webhookUrl ? { config: { webhooks: [{ url: webhookUrl }] } } : {}),
        },
      };
    case "GET:id:me":
      return { status: 200, value: { id: "5511999998888@c.us", pushName: "Loja IT" } };
    case "POST:id:start":
      return { status: 200, value: {} };
    case "POST:-:-":
      return { status: 201, value: {} };
    case "GET:-:-":
      return { status: 200, value: [{ name: "it-session", status: sessionStatus }] };
    default:
      return { status: 404, value: { error: `unstubbed ${method} /${parts.join("/")}` } };
  }
}

/** WAHA route table — anything not listed answers 404 so a wrong call
 *  surfaces immediately in the test run. */
function stubRoute(
  method: string,
  path: string,
  { sessionStatus, webhookUrl }: { sessionStatus: string; webhookUrl?: string },
): StubReply {
  const parts = path.split("?")[0]!.split("/").filter(Boolean);
  if (method === "GET" && path.endsWith("/auth/qr")) {
    return { status: 200, png: Buffer.from("89504e47", "hex") };
  }
  if (parts[1] === "sessions") return sessionRoute(parts, method, { sessionStatus, webhookUrl });
  if (method === "POST" && parts[2] === "auth" && parts[3] === "request-code") {
    return { status: 200, value: { code: "ABCD-EFGH" } };
  }
  if (method === "GET" && parts[1] === "server" && parts[2] === "version") {
    return { status: 200, value: { version: "2026.1.0", engine: "GOWS" } };
  }
  return { status: 404, value: { error: `unstubbed ${method} ${path}` } };
}

async function startWahaStub(sessionStatus: string): Promise<Stub> {
  const state: { webhookUrl?: string } = {};
  const requests: Stub["requests"] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const method = req.method ?? "";
      const path = req.url ?? "";
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ method, path, body: raw ? (JSON.parse(raw) as unknown) : undefined });
      const reply = stubRoute(method, path, { sessionStatus, webhookUrl: state.webhookUrl });
      if (reply.png) {
        res.writeHead(reply.status, { "content-type": "image/png" });
        return res.end(reply.png);
      }
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.value));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    sessionStatus,
    get webhookUrl() {
      return state.webhookUrl;
    },
    set webhookUrl(value: string | undefined) {
      state.webhookUrl = value;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Credentials are platform-owned — point the envs at the stub and the
 *  service snapshots them into the (encrypted) connection row. */
async function createWahaConnection(baseUrl: string, name = "IT WAHA") {
  process.env.WAHA_BASE_URL = baseUrl;
  process.env.WAHA_API_KEY = "it-key";
  return createChannelConnection(db, ctx("owner"), { kind: "waha", name });
}

let stub: Stub;

beforeAll(async () => {
  process.env.CHANNEL_CREDENTIALS_KEY = "a".repeat(64);
  process.env.APP_URL = "https://app.test";
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
  const [user] = await db
    .insert(users)
    .values({ name: "IT User", email: `it-int-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  const [org] = await db
    .insert(organizations)
    .values({ name: "Int IT", slug: `int-${suffix}` })
    .returning({ id: organizations.id });
  orgId = org!.id;
  stub = await startWahaStub("WORKING");
});

afterAll(async () => {
  await stub.close();
  await db.delete(organizations).where(sql`${organizations.id} = ${orgId}`);
  await db.delete(users).where(sql`${users.id} = ${userId}`);
  await db.$client.end();
  process.env.CHANNEL_CREDENTIALS_KEY = ORIGINAL_KEY;
  process.env.APP_URL = ORIGINAL_APP_URL;
  if (ORIGINAL_WAHA_BASE_URL === undefined) delete process.env.WAHA_BASE_URL;
  else process.env.WAHA_BASE_URL = ORIGINAL_WAHA_BASE_URL;
  if (ORIGINAL_WAHA_API_KEY === undefined) delete process.env.WAHA_API_KEY;
  else process.env.WAHA_API_KEY = ORIGINAL_WAHA_API_KEY;
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

describe("refreshConnectionStatus (WAHA connect)", () => {
  it("registers the session webhook and reports connected + paired phone", async () => {
    const conn = await createWahaConnection(stub.url);
    const result = await refreshConnectionStatus(db, ctx("owner"), conn.id);

    expect(result.status).toBe("connected");
    expect(result.connection.externalRef).toBe("5511999998888");

    // The session update carried the full webhook config — per-connection
    // URL, all subscribed events and the generated HMAC key.
    const session = decryptJson<{ session: string; webhookHmacKey: string }>(
      conn.credentialsEncrypted,
    );
    const put = stub.requests.find(
      (r) => r.method === "PUT" && r.path === `/api/sessions/${session.session}`,
    );
    expect(put).toBeDefined();
    const body = put!.body as {
      config: { webhooks: { url: string; events: string[]; hmac?: { key: string } }[] };
    };
    expect(body.config.webhooks).toHaveLength(1);
    const hook = body.config.webhooks[0]!;
    expect(hook.url).toBe(`https://app.test/api/webhooks/channels/${conn.webhookToken}`);
    expect(hook.hmac?.key).toBe(session.webhookHmacKey);
    expect(hook.events).toEqual(
      expect.arrayContaining([
        "message",
        "message.ack",
        "message.reaction",
        "message.edited",
        "message.revoked",
        "session.status",
        "presence.update",
      ]),
    );
  });

  it("returns the QR code while the session waits for a scan", async () => {
    const scanStub = await startWahaStub("SCAN_QR_CODE");
    try {
      const conn = await createWahaConnection(scanStub.url);
      const result = await refreshConnectionStatus(db, ctx("owner"), conn.id);
      expect(result.status).toBe("connecting");
      expect(result.qrCode?.mimeType).toBe("image/png");
      expect(typeof result.qrCode?.data).toBe("string");
    } finally {
      await scanStub.close();
    }
  });

  it("does not rewrite config mid-pairing (PUT restarts the session)", async () => {
    const scanStub = await startWahaStub("SCAN_QR_CODE");
    try {
      const conn = await createWahaConnection(scanStub.url);
      scanStub.requests.length = 0;
      const result = await refreshConnectionStatus(db, ctx("owner"), conn.id);
      expect(result.status).toBe("connecting");
      expect(result.qrCode?.mimeType).toBe("image/png");
      expect(scanStub.requests.some((r) => r.method === "PUT")).toBe(false);
    } finally {
      await scanStub.close();
    }
  });

  it("skips the config PUT when our webhook is already registered", async () => {
    const conn = await createWahaConnection(stub.url);
    stub.webhookUrl = `https://app.test/api/webhooks/channels/${conn.webhookToken}`;
    try {
      stub.requests.length = 0;
      const result = await refreshConnectionStatus(db, ctx("owner"), conn.id);
      expect(result.status).toBe("connected");
      expect(stub.requests.some((r) => r.method === "PUT")).toBe(false);
    } finally {
      stub.webhookUrl = undefined;
    }
  });

  it("issues a pairing code for a phone number", async () => {
    const conn = await createWahaConnection(stub.url);
    const { code } = await requestConnectionPairingCode(db, ctx("owner"), {
      id: conn.id,
      phoneNumber: "5511999998888",
    });
    expect(code).toBe("ABCD-EFGH");
    const request = stub.requests.find((r) => r.path.endsWith("/auth/request-code"));
    expect(request?.body).toEqual({ phoneNumber: "5511999998888" });
  });
});
