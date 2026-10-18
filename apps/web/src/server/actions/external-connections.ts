"use server";

import { enqueueContactGoogleSweep } from "@crm/automation";
import { DomainError } from "@crm/core";
import {
  disconnectGoogle,
  enableGoogleAutoSync,
  saveGoogleClient,
  verifyGoogleConnection,
} from "@crm/core/external-connections";
import { getDb } from "@crm/db";
import { captureException } from "@crm/observability";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { googleRedirectUri } from "@/app/api/integrations/google/redirect";
import { requireTenantContext } from "@/server/tenant";

const CHANNELS_PATH = "/app/settings/channels";

export type GoogleConnectResult = { ok: true; authUrl: string } | { ok: false; error: string };
export type GoogleVerifyResult =
  { ok: true; status: string; error: string | null } | { ok: false; error: string };
export type GoogleActionResult = { ok: true } | { ok: false; error: string };
export type GoogleSyncResult = { ok: true; queued: number } | { ok: false; error: string };

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? fallback;
  }
  if (error instanceof DomainError) {
    return error.message;
  }
  captureException(error, { action: "external-connections" });
  return fallback;
}

/** Saves the org's OAuth client and returns the Google consent URL to redirect to. */
export async function connectGoogleAction(input: {
  clientId: string;
  clientSecret: string;
}): Promise<GoogleConnectResult> {
  const ctx = await requireTenantContext();
  try {
    const { authUrl } = await saveGoogleClient(getDb(), ctx, {
      ...input,
      redirectUri: googleRedirectUri(),
    });
    revalidatePath(CHANNELS_PATH);
    return { ok: true, authUrl };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível iniciar a conexão.") };
  }
}

/** Live token check — reports the resulting status instead of throwing on a dead token. */
export async function verifyGoogleAction(): Promise<GoogleVerifyResult> {
  const ctx = await requireTenantContext();
  try {
    const connection = await verifyGoogleConnection(getDb(), ctx);
    revalidatePath(CHANNELS_PATH);
    return { ok: true, status: connection.status, error: connection.lastError };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível verificar a conexão.") };
  }
}

export async function disconnectGoogleAction(): Promise<GoogleActionResult> {
  const ctx = await requireTenantContext();
  try {
    await disconnectGoogle(getDb(), ctx);
    revalidatePath(CHANNELS_PATH);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível desconectar.") };
  }
}

const SYNC_COOLDOWN_MS = 60_000;
// shortcut: per-process memory, so N instances allow N requests per window; move to the DB if abused.
const lastSyncRequest = new Map<string, number>();

/**
 * Records the org's consent to automatic sync and queues a sweep, which enqueues
 * one Google sync job per pending contact (the job skips what is unchanged).
 * `queued` is 0: the sweep counts them later, the card shows the progress.
 */
export async function syncGoogleContactsAction(): Promise<GoogleSyncResult> {
  const ctx = await requireTenantContext();
  const last = lastSyncRequest.get(ctx.organizationId);
  if (last !== undefined && Date.now() - last < SYNC_COOLDOWN_MS) {
    return { ok: false, error: "A sincronização já foi iniciada. Aguarde um minuto." };
  }
  lastSyncRequest.set(ctx.organizationId, Date.now());
  try {
    await enableGoogleAutoSync(getDb(), ctx);
    const { skipped } = await enqueueContactGoogleSweep({ organizationId: ctx.organizationId });
    if (skipped) throw new DomainError("GOOGLE_QUEUE_UNAVAILABLE", "A fila não está disponível.");
    return { ok: true, queued: 0 };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível iniciar a sincronização.") };
  } finally {
    revalidatePath(CHANNELS_PATH);
  }
}
