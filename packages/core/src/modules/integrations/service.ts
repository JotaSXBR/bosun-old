import { randomBytes } from "node:crypto";

import type { ChannelProvider, ConnectResult, ServerInfo, SessionInfo } from "@crm/channels";
import { createChannelProvider } from "@crm/channels";
import type { Database, DbExecutor } from "@crm/db";
import { withServiceAccess, withTenant } from "@crm/db";
import { z } from "zod";

import { DomainError, NotFoundError } from "../../errors";
import { decryptJson, encryptJson } from "../../lib/crypto";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { resolveMetaConfig } from "../platform";
import type { ChannelConnectionRow } from "./repository";
import {
  deleteChannelConnection,
  findConnectionByWebhookToken,
  getChannelConnection,
  insertChannelConnection,
  listChannelConnections,
  listReconcilableConnections,
  updateConnectionMetadata,
  updateConnectionStatus,
} from "./repository";
import type { CreateChannelConnectionInput, MetaCloudCredentialsInput } from "./schemas";
import {
  createChannelConnectionInput,
  metaCloudCredentialsSchema,
  wahaCredentialsSchema,
  widgetConfigSchema,
} from "./schemas";

/** Requires integrations:read (every org member). */
export async function listChannelConnectionsForTenant(
  db: Database,
  ctx: TenantContext,
): Promise<ChannelConnectionRow[]> {
  assertPermission(ctx, { integrations: ["read"] });
  return listChannelConnections(db, ctx.organizationId);
}

/**
 * Requires integrations:manage. Generates the unguessable webhook token and
 * encrypts credentials at rest; status stays 'pending' until the provider is
 * reachable (see refreshConnectionStatus).
 */
export async function createChannelConnection(
  db: Database,
  ctx: TenantContext,
  input: CreateChannelConnectionInput,
): Promise<ChannelConnectionRow> {
  assertPermission(ctx, { integrations: ["manage"] });
  const parsed = createChannelConnectionInput.parse(input);
  const credentials =
    parsed.kind === "waha"
      ? wahaPlatformCredentials(parsed.name)
      : parsed.kind === "site_chat"
        ? {}
        : await metaCredentialsWithPlatformFallback(db, parsed.credentials);
  return insertChannelConnection(db, ctx.organizationId, {
    kind: parsed.kind,
    name: parsed.name,
    credentialsEncrypted: encryptJson(credentials),
    webhookToken: randomBytes(24).toString("base64url"),
  });
}

/**
 * Requires integrations:manage. Drives the provider connect flow — WAHA:
 * create/register/start the session and re-register the webhook; returns
 * the live result including the QR code while pairing. Persists status;
 * when connected, also stores the paired phone as externalRef.
 */
export async function refreshConnectionStatus(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<RefreshResult> {
  assertPermission(ctx, { integrations: ["manage"] });
  const conn = await getConnectionOrThrow(db, ctx, id);
  const provider = providerFor(conn);
  const result = await provider.connect();

  // On connect, read /me once so externalRef shows the paired number.
  let externalRef = conn.externalRef ?? undefined;
  if (result.status === "connected" && provider.getSessionInfo) {
    const info = await provider.getSessionInfo().catch(() => undefined);
    if (info?.phone) externalRef = info.phone;
  }

  await withTenant(db, ctx.organizationId, (tx) =>
    updateConnectionStatus(tx, conn.id, {
      status: result.status,
      connectedAt: result.status === "connected" ? new Date() : null,
      ...(externalRef ? { externalRef } : {}),
    }),
  );
  const updated = await getChannelConnection(db, ctx.organizationId, conn.id);
  if (!updated) throw new NotFoundError("Channel connection", id);
  return { connection: updated, status: result.status, qrCode: result.qrCode };
}

export type RefreshResult = {
  connection: ChannelConnectionRow;
  status: ConnectResult["status"];
  qrCode?: ConnectResult["qrCode"];
};

/**
 * Requires integrations:manage. WhatsApp "connect with phone number" —
 * returns the code the user types in WhatsApp (Aparelhos conectados →
 * Conectar com número). WAHA-only.
 */
export async function requestConnectionPairingCode(
  db: Database,
  ctx: TenantContext,
  { id, phoneNumber }: { id: string; phoneNumber: string },
): Promise<{ code: string }> {
  assertPermission(ctx, { integrations: ["manage"] });
  const parsed = z
    .string()
    .regex(/^\d{10,15}$/, "Informe o número com DDI+DDD, só dígitos")
    .parse(phoneNumber);
  const conn = await getConnectionOrThrow(db, ctx, id);
  const provider = providerFor(conn);
  if (!provider.requestPairingCode) {
    throw new DomainError("PROVIDER_UNSUPPORTED", "Este canal não suporta código de pareamento.");
  }
  return provider.requestPairingCode(parsed);
}

/**
 * Requires integrations:manage. Lifecycle actions — `stop` parks the
 * session (reconnectable), `logout` unpairs (needs QR again), `restart`
 * bounces a broken session in place.
 */
export async function connectionLifecycle(
  db: Database,
  ctx: TenantContext,
  { id, action }: { id: string; action: "stop" | "logout" | "restart" },
): Promise<RefreshResult> {
  assertPermission(ctx, { integrations: ["manage"] });
  const conn = await getConnectionOrThrow(db, ctx, id);
  const provider = providerFor(conn);
  if (action === "stop") await provider.disconnect();
  else if (action === "logout") await (provider.logout?.() ?? provider.disconnect());
  else if (provider.restart) await provider.restart();
  const status =
    (await provider.getSessionInfo?.().catch(() => undefined))?.status ??
    (await provider.getConnectionStatus());
  await withTenant(db, ctx.organizationId, (tx) =>
    updateConnectionStatus(tx, conn.id, {
      status,
      connectedAt: status === "connected" ? conn.connectedAt : null,
    }),
  );
  const updated = await getChannelConnection(db, ctx.organizationId, conn.id);
  if (!updated) throw new NotFoundError("Channel connection", id);
  return { connection: updated, status };
}

/**
 * Requires integrations:manage. Widget config (welcome text, accent color,
 * position) merges into the connection metadata — site_chat only.
 */
export async function updateWidgetConfig(
  db: Database,
  ctx: TenantContext,
  { id, config }: { id: string; config: unknown },
): Promise<ChannelConnectionRow> {
  assertPermission(ctx, { integrations: ["manage"] });
  const conn = await getConnectionOrThrow(db, ctx, id);
  if (conn.kind !== "site_chat") {
    throw new DomainError("PROVIDER_UNSUPPORTED", "Configuração de widget só existe em site_chat.");
  }
  const parsed = widgetConfigSchema.parse(config);
  await withTenant(db, ctx.organizationId, (tx) => updateConnectionMetadata(tx, conn.id, parsed));
  const updated = await getChannelConnection(db, ctx.organizationId, conn.id);
  if (!updated) throw new NotFoundError("Channel connection", id);
  return updated;
}

/**
 * Internal (jobs): resolves a connection row + provider by id. No
 * permission assertion — callers are trusted server-side paths (job
 * payloads carry identity only; the handler re-scopes every write under
 * the row's organizationId).
 */
export async function resolveConnectionProvider(
  db: Database,
  organizationId: string,
  connectionId: string,
): Promise<{ connection: ChannelConnectionRow; provider: ChannelProvider } | undefined> {
  const conn = await getChannelConnection(db, organizationId, connectionId);
  if (!conn) return undefined;
  return { connection: conn, provider: providerFor(conn) };
}

/**
 * Internal (scheduled sweep): every connection that can be reconciled —
 * WAHA sessions whose status is `connected`.
 */
export async function listConnectionsForReconcile(db: Database): Promise<ChannelConnectionRow[]> {
  return withServiceAccess(db, (tx) => listReconcilableConnections(tx));
}

export type ConnectionHealth = {
  session?: SessionInfo;
  server?: ServerInfo;
};

/**
 * Requires integrations:read. Live health card data — session info (paired
 * phone, restriction warnings) + WAHA server version. Read-only, no side
 * effects.
 */
export async function getConnectionHealth(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<ConnectionHealth> {
  assertPermission(ctx, { integrations: ["read"] });
  const conn = await getConnectionOrThrow(db, ctx, id);
  const provider = providerFor(conn);
  const session = await provider.getSessionInfo?.().catch(() => undefined);
  const server = await provider.getServerInfo?.().catch(() => undefined);
  return { session, server };
}

/** Requires integrations:manage. */
export async function removeChannelConnection(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<void> {
  assertPermission(ctx, { integrations: ["manage"] });
  const deleted = await deleteChannelConnection(db, ctx.organizationId, id);
  if (!deleted) throw new NotFoundError("Channel connection", id);
}

/**
 * Requires integrations:read. Returns the webhook path for a connection; the
 * action layer prefixes the request origin to form the full URL.
 */
export async function getConnectionWebhookUrl(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<string> {
  assertPermission(ctx, { integrations: ["read"] });
  const conn = await getConnectionOrThrow(db, ctx, id);
  return `/api/webhooks/channels/${conn.webhookToken}`;
}

/**
 * Internal — no TenantContext by design. Webhook ingestion resolves the
 * connection under service scope (token is unguessable; the provider
 * signature is verified by the caller next) and returns it with a ready
 * provider. Returns undefined for an unknown token.
 */
export async function resolveWebhookConnection(
  db: Database,
  webhookToken: string,
): Promise<{ connection: ChannelConnectionRow; provider: ChannelProvider } | undefined> {
  const connection = await withServiceAccess(db, (tx) =>
    findConnectionByWebhookToken(tx, webhookToken),
  );
  if (!connection) return undefined;
  const provider = providerFor(connection);
  return { connection, provider };
}

/**
 * Service-scope connection.status write — runs inside the caller's
 * withTenant transaction (the organizationId comes from the authenticated
 * connection row, never from the event payload).
 */
export async function applyConnectionStatus(
  executor: DbExecutor,
  connectionId: string,
  status: string,
): Promise<void> {
  await updateConnectionStatus(executor, connectionId, {
    status,
    connectedAt: status === "connected" ? new Date() : null,
  });
}

/**
 * Internal — resolves a stored connection to a ready ChannelProvider (tenant
 * read, credentials decrypted in-memory only). The returned provider must
 * never reach the client; callers pass it to send/connect only.
 */
export async function providerForConnection(
  db: Database,
  organizationId: string,
  connectionId: string,
): Promise<ChannelProvider> {
  const conn = await getChannelConnection(db, organizationId, connectionId);
  if (!conn) throw new NotFoundError("Channel connection", connectionId);
  return providerFor(conn);
}

async function getConnectionOrThrow(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<ChannelConnectionRow> {
  const conn = await getChannelConnection(db, ctx.organizationId, id);
  if (!conn) throw new NotFoundError("Channel connection", id);
  return conn;
}

/**
 * Builds the per-connection webhook URL WAHA posts to. `APP_URL` is read
 * directly like crypto.ts reads its key — @crm/config validates it at boot.
 * Undefined when the env is absent (unit tests) — the adapter then skips
 * webhook registration.
 */
function webhookUrlFor(webhookToken: string): string | undefined {
  const base = process.env.APP_URL?.replace(/\/+$/, "");
  return base ? `${base}/api/webhooks/channels/${webhookToken}` : undefined;
}

/**
 * WAHA credentials are platform-owned: baseUrl/apiKey come from env (read
 * directly like webhookUrlFor reads APP_URL — @crm/config validates them at
 * boot). The webhook HMAC key is generated per connection and the session
 * name derives from the connection name with a random suffix — two
 * connections with the same name must never share a WAHA session or their
 * webhooks would cross-wire.
 */
function wahaPlatformCredentials(name: string) {
  const baseUrl = process.env.WAHA_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new DomainError(
      "WAHA_NOT_CONFIGURED",
      "WhatsApp (WAHA) não está configurado nesta instância.",
    );
  }
  return {
    baseUrl,
    apiKey,
    webhookHmacKey: randomBytes(24).toString("base64url"),
    session: sessionNameFrom(name),
  };
}

/**
 * Meta app-level secrets (appSecret/verifyToken/graphApiVersion) may be
 * omitted per connection — platform_settings.meta fills the gaps. The merged
 * snapshot is validated against the strict credentials schema, so a missing
 * appSecret/verifyToken with no platform default fails here with a clear
 * error instead of a broken connection later.
 */
async function metaCredentialsWithPlatformFallback(db: Database, input: MetaCloudCredentialsInput) {
  const platform = await resolveMetaConfig(db);
  const merged = {
    phoneNumberId: input.phoneNumberId,
    accessToken: input.accessToken,
    appSecret: input.appSecret ?? platform.appSecret,
    verifyToken: input.verifyToken ?? platform.verifyToken,
    graphApiVersion: input.graphApiVersion ?? platform.graphApiVersion,
  };
  const result = metaCloudCredentialsSchema.safeParse(merged);
  if (!result.success) {
    throw new DomainError(
      "META_CREDENTIALS_INCOMPLETE",
      "Credenciais Meta incompletas — informe appSecret/verifyToken na conexão ou configure o grupo Meta nas settings da plataforma.",
    );
  }
  return result.data;
}

/** URL-safe slug of the connection name + uniqueness suffix. */
function sessionNameFrom(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 55);
  return slug
    ? `${slug}-${randomBytes(4).toString("hex")}`
    : `conn_${randomBytes(8).toString("hex")}`;
}

/** Decrypts credentials and builds the provider with the conn's webhook URL. */
function providerFor(conn: ChannelConnectionRow): ChannelProvider {
  return providerFromCredentials(
    conn.kind,
    decryptJson(conn.credentialsEncrypted),
    webhookUrlFor(conn.webhookToken),
  );
}

function providerFromCredentials(kind: string, raw: unknown, webhookUrl?: string): ChannelProvider {
  if (kind === "waha") {
    const credentials = wahaCredentialsSchema.parse(raw);
    return createChannelProvider({ kind: "waha", ...credentials, webhookUrl });
  }
  if (kind === "site_chat") {
    return createChannelProvider({ kind: "site_chat" });
  }
  const credentials = metaCloudCredentialsSchema.parse(raw);
  return createChannelProvider({ kind: "meta_cloud", ...credentials });
}
