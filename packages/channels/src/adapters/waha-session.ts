// WAHA session lifecycle — create/update/start, QR, pairing code, status.
// Standalone functions over the provider's request helper + config so
// waha.ts stays under the file-size limit.
import { z } from "zod";

import type { ConnectionStatus, ConnectResult, ServerInfo, SessionInfo } from "../domain";
import type { WahaRequest } from "./waha-actions";
import {
  mapSessionStatus,
  WAHA_WEBHOOK_EVENTS,
  WAHA_WEBHOOK_RETRIES,
  type WahaConfig,
  wahaMeSchema,
  wahaPairingCodeSchema,
  wahaServerVersionSchema,
  wahaSessionSchema,
} from "./waha-payloads";

export type SessionCtx = { config: WahaConfig; request: WahaRequest };

type WahaSession = z.infer<typeof wahaSessionSchema>;
type SessionConfig = { webhooks: Record<string, unknown>[] };

async function getSession({ config, request }: SessionCtx): Promise<WahaSession | null> {
  const res = await request(`/api/sessions/${config.session}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`WAHA get session failed: HTTP ${res.status}`);
  return wahaSessionSchema.parse(await res.json());
}

/**
 * Session `config` for create/update — the per-connection webhook with
 * HMAC + retries. Undefined when no webhookUrl is configured (never send
 * an empty config: PUT is a full replace and would wipe the session's
 * webhooks).
 */
function webhookSessionConfig(config: WahaConfig): SessionConfig | undefined {
  if (!config.webhookUrl) return undefined;
  const webhook: Record<string, unknown> = {
    url: config.webhookUrl,
    events: [...WAHA_WEBHOOK_EVENTS],
    retries: { ...WAHA_WEBHOOK_RETRIES },
  };
  if (config.webhookHmacKey) {
    webhook.hmac = { key: config.webhookHmacKey };
  }
  return { webhooks: [webhook] };
}

/** Idempotent config write — PUT is a FULL replace, send the whole config. */
async function writeSessionConfig(
  { config, request }: SessionCtx,
  sessionConfig: SessionConfig,
): Promise<void> {
  const res = await request(`/api/sessions/${config.session}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: config.session, config: sessionConfig }),
  });
  if (!res.ok) {
    throw new Error(`WAHA update session config failed: HTTP ${res.status}`);
  }
}

async function createSession(
  { config, request }: SessionCtx,
  sessionConfig: SessionConfig | undefined,
): Promise<void> {
  const created = await request(`/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: config.session,
      start: true,
      ...(sessionConfig ? { config: sessionConfig } : {}),
    }),
  });
  if (!created.ok) {
    throw new Error(`WAHA create session failed: HTTP ${created.status}`);
  }
}

async function updateSession(
  ctx: SessionCtx,
  existing: WahaSession,
  sessionConfig: SessionConfig | undefined,
): Promise<void> {
  // A config PUT restarts the session — rewriting it on every connect
  // poll keeps the session bouncing STARTING↔SCAN_QR_CODE and the QR
  // is never fetched. Skip when our webhook is already registered or
  // the session is mid-pairing (config necessarily got there with it).
  const webhookRegistered = existing.config?.webhooks?.some(
    (hook) => hook.url === ctx.config.webhookUrl,
  );
  if (sessionConfig && !webhookRegistered && existing.status !== "SCAN_QR_CODE") {
    await writeSessionConfig(ctx, sessionConfig);
  }
  if (existing.status === "STOPPED" || existing.status === "FAILED") {
    const started = await ctx.request(`/api/sessions/${ctx.config.session}/start`, {
      method: "POST",
    });
    if (!started.ok) {
      throw new Error(`WAHA start session failed: HTTP ${started.status}`);
    }
  }
}

async function getQrCode({ config, request }: SessionCtx): Promise<ConnectResult["qrCode"]> {
  const res = await request(`/api/${config.session}/auth/qr`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return undefined;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = z
      .looseObject({ mimetype: z.string().optional(), data: z.string().optional() })
      .parse(await res.json());
    if (!body.data) return undefined;
    return { mimeType: body.mimetype ?? "image/png", data: body.data };
  }
  const buffer = await res.arrayBuffer();
  return {
    mimeType: contentType || "image/png",
    data: Buffer.from(buffer).toString("base64"),
  };
}

export async function wahaConnect(ctx: SessionCtx): Promise<ConnectResult> {
  const existing = await getSession(ctx);
  const sessionConfig = webhookSessionConfig(ctx.config);
  if (!existing) await createSession(ctx, sessionConfig);
  else await updateSession(ctx, existing, sessionConfig);

  const session = await getSession(ctx);
  const status = mapSessionStatus(session?.status ?? "FAILED");
  const result: ConnectResult = { status };
  if (session?.status === "SCAN_QR_CODE") {
    result.qrCode = await getQrCode(ctx);
  }
  return result;
}

/** stop / restart / logout — a 404 means the session is already gone. */
export async function wahaSessionCommand(
  { config, request }: SessionCtx,
  command: "stop" | "restart" | "logout",
): Promise<void> {
  const res = await request(`/api/sessions/${config.session}/${command}`, { method: "POST" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`WAHA ${command} session failed: HTTP ${res.status}`);
  }
}

/** WhatsApp "connect with phone number" — the code the user types in the app. */
export async function wahaRequestPairingCode(
  { config, request }: SessionCtx,
  phoneNumber: string,
): Promise<{ code: string }> {
  const res = await request(`/api/${config.session}/auth/request-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneNumber }),
  });
  if (!res.ok) {
    throw new Error(`WAHA request pairing code failed: HTTP ${res.status}`);
  }
  return wahaPairingCodeSchema.parse(await res.json());
}

/** Copies the /me payload (phone, name, account warnings) onto the session info. */
function applyMe(info: SessionInfo, me: z.infer<typeof wahaMeSchema>): void {
  if (me.id) info.phone = me.id.split("@")[0];
  if (me.pushName) info.pushName = me.pushName;
  if (me.reachoutTimelock) info.warnings.push("reachout_timelock");
  const capping = me.messageCapping?.state;
  if (capping && capping !== "NONE") {
    info.warnings.push(`message_capping:${capping.toLowerCase()}`);
  }
}

export async function wahaGetSessionInfo(ctx: SessionCtx): Promise<SessionInfo> {
  const session = await getSession(ctx);
  const status = mapSessionStatus(session?.status ?? "STOPPED");
  const info: SessionInfo = { status, warnings: [] };
  const res = await ctx.request(`/api/sessions/${ctx.config.session}/me`);
  if (!res.ok) return info;
  applyMe(info, wahaMeSchema.parse(await res.json()));
  return info;
}

export async function wahaGetServerInfo({ request }: SessionCtx): Promise<ServerInfo> {
  const res = await request(`/api/server/version`);
  if (!res.ok) {
    throw new Error(`WAHA server version failed: HTTP ${res.status}`);
  }
  const parsed = wahaServerVersionSchema.parse(await res.json());
  return { version: parsed.version, engine: parsed.engine ?? "unknown", tier: parsed.tier };
}

export async function wahaGetConnectionStatus(ctx: SessionCtx): Promise<ConnectionStatus> {
  const session = await getSession(ctx);
  return mapSessionStatus(session?.status ?? "STOPPED");
}
