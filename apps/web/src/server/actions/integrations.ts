"use server";

import { enqueueChannelReconcile } from "@crm/automation";
import type { TenantContext } from "@crm/core";
import { DomainError } from "@crm/core";
import type { ConnectionHealth, CreateChannelConnectionInput } from "@crm/core/integrations";
import {
  connectionLifecycle,
  createChannelConnection,
  getConnectionHealth,
  refreshConnectionStatus,
  removeChannelConnection,
  requestConnectionPairingCode,
  updateWidgetConfig,
} from "@crm/core/integrations";
import { completeStep } from "@crm/core/onboarding";
import { getDb } from "@crm/db";
import { captureException } from "@crm/observability";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireTenantContext } from "@/server/tenant";

export type IntegrationActionResult = { ok: true } | { ok: false; error: string };

export type CreateConnectionResult =
  | {
      ok: true;
      connectionId: string;
      status: string;
      qrCode?: { mimeType: string; data: string };
      /** Connection created but the provider connect call failed — the
       *  pairing panel retries via connectChannelConnectionAction. */
      warning?: string;
    }
  | { ok: false; error: string };

export type ConnectActionResult =
  | {
      ok: true;
      status: string;
      qrCode?: { mimeType: string; data: string };
    }
  | { ok: false; error: string };

export type PairingCodeResult = { ok: true; code: string } | { ok: false; error: string };

export type HealthResult = { ok: true; health: ConnectionHealth } | { ok: false; error: string };

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? fallback;
  }
  if (error instanceof DomainError) {
    return error.message;
  }
  captureException(error, { action: "integrations" });
  return fallback;
}

type PairingState = {
  status: string;
  qrCode?: { mimeType: string; data: string };
  warning?: string;
};

/** Drives the new connection up; a provider failure only downgrades to a warning. */
async function pairNewConnection(
  ctx: TenantContext,
  conn: { id: string; status: string },
): Promise<PairingState> {
  let pairing: PairingState = { status: conn.status };
  try {
    const refresh = await refreshConnectionStatus(getDb(), ctx, conn.id);
    pairing = { status: refresh.status, qrCode: refresh.qrCode };
    if (refresh.status === "connected") {
      await enqueueChannelReconcile({
        organizationId: ctx.organizationId,
        channelConnectionId: conn.id,
      });
    }
  } catch (connectError) {
    captureException(connectError, { action: "integrations.create-connect" });
    pairing = {
      ...pairing,
      warning: "Conexão criada, mas o provedor não respondeu — tente Conectar.",
    };
  }
  return pairing;
}

/**
 * Create + connect in one call: for WAHA the QR code comes back immediately
 * (pairing panel polls connectChannelConnectionAction to keep it fresh).
 * A failed connect doesn't roll back the row — the connection stays pending
 * and the panel retries.
 */
export async function createChannelConnectionAction(
  input: unknown,
): Promise<CreateConnectionResult> {
  const ctx = await requireTenantContext();
  try {
    const conn = await createChannelConnection(getDb(), ctx, input as CreateChannelConnectionInput);
    const { status, qrCode, warning } = await pairNewConnection(ctx, conn);
    try {
      await completeStep(getDb(), ctx, "connect_channel");
    } catch (checklistError) {
      captureException(checklistError, { action: "integrations.checklist" });
    }
    revalidatePath("/app/settings/channels");
    return { ok: true, connectionId: conn.id, status, qrCode, warning };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível criar a conexão.") };
  }
}

/**
 * "Conectar" / "Reconectar" — drives the WAHA session up (registers the
 * webhook) and returns pairing state. Also the QR poll: calling it again
 * returns a fresh QR while the session is SCAN_QR_CODE. On connected, a
 * reconcile job backfills whatever arrived while the stack was down.
 */
export async function connectChannelConnectionAction(id: string): Promise<ConnectActionResult> {
  const ctx = await requireTenantContext();
  try {
    const result = await refreshConnectionStatus(getDb(), ctx, id);
    if (result.status === "connected") {
      await enqueueChannelReconcile({
        organizationId: ctx.organizationId,
        channelConnectionId: id,
      });
    }
    revalidatePath("/app/settings/channels");
    return { ok: true, status: result.status, qrCode: result.qrCode };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível conectar.") };
  }
}

/** "Conectar com número" — WhatsApp pairing code for the given phone. */
export async function requestPairingCodeAction(
  id: string,
  phoneNumber: string,
): Promise<PairingCodeResult> {
  const ctx = await requireTenantContext();
  try {
    const { code } = await requestConnectionPairingCode(getDb(), ctx, { id, phoneNumber });
    return { ok: true, code };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível gerar o código.") };
  }
}

/** stop / restart / logout (desparear) — see `connectionLifecycle`. */
export async function connectionLifecycleAction(
  id: string,
  action: "stop" | "restart" | "logout",
): Promise<ConnectActionResult> {
  const ctx = await requireTenantContext();
  try {
    const result = await connectionLifecycle(getDb(), ctx, { id, action });
    revalidatePath("/app/settings/channels");
    return { ok: true, status: result.status };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível executar a ação.") };
  }
}

/** Live health data for the connection card (session + WAHA version). */
export async function connectionHealthAction(id: string): Promise<HealthResult> {
  const ctx = await requireTenantContext();
  try {
    return { ok: true, health: await getConnectionHealth(getDb(), ctx, id) };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível consultar a conexão.") };
  }
}

export async function deleteChannelConnectionAction(id: string): Promise<IntegrationActionResult> {
  const ctx = await requireTenantContext();
  try {
    await removeChannelConnection(getDb(), ctx, id);
    revalidatePath("/app/settings/channels");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível excluir a conexão.") };
  }
}

/** Save the site_chat widget config (welcome text, accent, position). */
export async function updateWidgetConfigAction(
  id: string,
  config: unknown,
): Promise<IntegrationActionResult> {
  const ctx = await requireTenantContext();
  try {
    await updateWidgetConfig(getDb(), ctx, { id, config });
    revalidatePath("/app/settings/channels");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível salvar o widget.") };
  }
}
