// Shared setup for the integrations service integration tests (not a test file itself).
import { createServer, type Server } from "node:http";

import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, sql } from "@crm/db";
import { afterAll, beforeAll } from "vitest";

import type { TenantContext } from "../../tenant/context";
import { createChannelConnection } from "./service";

const { organizations, users } = schema;

const ORIGINAL_KEY = process.env.CHANNEL_CREDENTIALS_KEY;
const ORIGINAL_APP_URL = process.env.APP_URL;
const ORIGINAL_WAHA_BASE_URL = process.env.WAHA_BASE_URL;
const ORIGINAL_WAHA_API_KEY = process.env.WAHA_API_KEY;

/**
 * Minimal WAHA stub — records requests and answers the endpoints the
 * adapter's connect flow touches. `sessionStatus` lets each test steer
 * the lifecycle; `requests` is asserted after the run.
 */
export type Stub = {
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

export async function startWahaStub(sessionStatus: string): Promise<Stub> {
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

type State = { db: Database; orgId: string; userId: string; stub: Stub };

async function assertMigrated(db: Database): Promise<void> {
  try {
    await db.execute(sql`select 1`);
  } catch (error) {
    throw new Error(
      "Integration tests require a migrated database. Run `pnpm infra:up && pnpm db:migrate` first.",
      { cause: error },
    );
  }
}

async function setUp(): Promise<State> {
  process.env.CHANNEL_CREDENTIALS_KEY = "a".repeat(64);
  process.env.APP_URL = "https://app.test";
  const env = getServerEnv();
  const db = createDb(env.database.url);
  await assertMigrated(db);
  const suffix = crypto.randomUUID().slice(0, 8);
  const [user] = await db
    .insert(users)
    .values({ name: "IT User", email: `it-int-${suffix}@crm.local` })
    .returning({ id: users.id });
  const [org] = await db
    .insert(organizations)
    .values({ name: "Int IT", slug: `int-${suffix}` })
    .returning({ id: organizations.id });
  return { db, orgId: org!.id, userId: user!.id, stub: await startWahaStub("WORKING") };
}

async function tearDown({ db, orgId, userId, stub }: State) {
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
}

/**
 * Registers the org/user/WAHA-stub hooks and returns accessors plus the
 * helpers bound to them. Call once at the top of a test file.
 */
export function useIntegrationsFixture() {
  let state: State;
  beforeAll(async () => {
    state = await setUp();
  });
  afterAll(() => tearDown(state));

  return {
    db: () => state.db,
    stub: () => state.stub,
    ctx: (role: TenantContext["role"]): TenantContext => ({
      organizationId: state.orgId,
      userId: state.userId,
      role,
      isPlatformAdmin: false,
    }),
    /** Credentials are platform-owned — point the envs at the stub and the
     *  service snapshots them into the (encrypted) connection row. */
    createWahaConnection: async (baseUrl: string, name = "IT WAHA") => {
      process.env.WAHA_BASE_URL = baseUrl;
      process.env.WAHA_API_KEY = "it-key";
      return createChannelConnection(state.db, fixtureCtx(state), { kind: "waha", name });
    },
  };
}

const fixtureCtx = ({ orgId, userId }: State): TenantContext => ({
  organizationId: orgId,
  userId,
  role: "owner",
  isPlatformAdmin: false,
});
