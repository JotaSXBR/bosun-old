"use server";

import { enqueueGenerateDraft } from "@crm/automation";
import type { TenantContext } from "@crm/core";
import { assertPermission, DomainError } from "@crm/core";
import { hasOrgLlmCredentials } from "@crm/core/ai";
import type { RequestDraftInput, ReviewDraftInput } from "@crm/core/drafts";
import {
  approveDraft,
  findNudgeById,
  parseDraftRequest,
  rejectDraft,
  reviewDraftInput,
  reviewNudge,
} from "@crm/core/drafts";
import { getDb, withTenant } from "@crm/db";
import { captureException } from "@crm/observability";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireTenantContext } from "@/server/tenant";

export type DraftActionResult = { ok: true; id?: string } | { ok: false; error: string };

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? fallback;
  }
  if (error instanceof DomainError) {
    return error.message;
  }
  captureException(error, { action: "drafts" });
  return fallback;
}

/** Returns a user-facing error when the draft job can't be enqueued, else null. */
async function enqueueDraftGeneration(
  ctx: TenantContext,
  input: { conversationId: string; mode: "suggest" | "improve"; sourceText?: string },
): Promise<string | null> {
  const configured = await withTenant(getDb(), ctx.organizationId, (tx) =>
    hasOrgLlmCredentials(tx, ctx.organizationId),
  );
  if (!configured) {
    return "Configure uma credencial de IA em Configurações > IA antes de gerar sugestões.";
  }
  const enqueued = await enqueueGenerateDraft({
    organizationId: ctx.organizationId,
    conversationId: input.conversationId,
    mode: input.mode,
    sourceText: input.sourceText,
    requestedBy: ctx.userId,
  });
  return enqueued.skipped ? "A fila de tarefas não está ativa — tente novamente." : null;
}

/**
 * Composer buttons — validates, checks messaging:write, then enqueues the
 * drafter job. Generation is async: the card lands via SSE refresh. A
 * missing BYOK credential fails here, in the click — the job's silent
 * skip is for system paths, not for a user waiting on a card.
 */
export async function requestDraftAction(input: RequestDraftInput): Promise<DraftActionResult> {
  const ctx = await requireTenantContext();
  try {
    const parsed = parseDraftRequest(input);
    assertPermission(ctx, { messaging: ["write"] });
    if (parsed.mode === "improve" && !parsed.sourceText) {
      return { ok: false, error: "Escreva algo no composer para melhorar." };
    }
    const enqueueError = await enqueueDraftGeneration(ctx, {
      conversationId: parsed.conversationId,
      mode: parsed.mode,
      sourceText: parsed.mode === "improve" ? parsed.sourceText : undefined,
    });
    return enqueueError ? { ok: false, error: enqueueError } : { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível gerar a sugestão.") };
  }
}

export async function approveDraftAction(input: ReviewDraftInput): Promise<DraftActionResult> {
  const ctx = await requireTenantContext();
  try {
    const parsed = reviewDraftInput.parse(input);
    const row = await approveDraft(getDb(), ctx, { suggestionId: parsed.suggestionId });
    revalidatePath("/app/inbox");
    return { ok: true, id: row.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível enviar a resposta.") };
  }
}

export async function rejectDraftAction(input: ReviewDraftInput): Promise<DraftActionResult> {
  const ctx = await requireTenantContext();
  try {
    const parsed = reviewDraftInput.parse(input);
    const row = await rejectDraft(getDb(), ctx, parsed.suggestionId);
    revalidatePath("/app/inbox");
    return { ok: true, id: row.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível descartar a sugestão.") };
  }
}

/** A workable nudge yields its conversationId; anything else is an error result. */
async function nudgeConversationId(
  ctx: TenantContext,
  suggestionId: string,
): Promise<{ conversationId: string } | { error: string }> {
  const nudge = await findNudgeById(getDb(), ctx, suggestionId);
  return nudge.status === "pending" && nudge.sourceConversationId
    ? { conversationId: nudge.sourceConversationId }
    : { error: "Este alerta já foi resolvido." };
}

/** Enqueues the drafter for a pending nudge — returns an error string or null. */
async function enqueueForNudge(ctx: TenantContext, suggestionId: string): Promise<string | null> {
  const resolved = await nudgeConversationId(ctx, suggestionId);
  return "error" in resolved
    ? resolved.error
    : enqueueDraftGeneration(ctx, { conversationId: resolved.conversationId, mode: "suggest" });
}

/**
 * Nudge "Gerar sugestão": enqueues the drafter first — a skipped enqueue
 * (boss down) or missing credential leaves the nudge pending so the user
 * can retry; only on success the nudge is marked approved.
 */
export async function generateFromNudgeAction(input: ReviewDraftInput): Promise<DraftActionResult> {
  const ctx = await requireTenantContext();
  try {
    const parsed = reviewDraftInput.parse(input);
    assertPermission(ctx, { messaging: ["write"] });
    const enqueueError = await enqueueForNudge(ctx, parsed.suggestionId);
    if (enqueueError) {
      return { ok: false, error: enqueueError };
    }
    return reviewNudge(getDb(), ctx, {
      suggestionId: parsed.suggestionId,
      action: "approved",
    }).then(() => {
      revalidatePath("/app/inbox");
      return { ok: true };
    });
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível gerar a sugestão.") };
  }
}

export async function dismissNudgeAction(input: ReviewDraftInput): Promise<DraftActionResult> {
  const ctx = await requireTenantContext();
  try {
    const parsed = reviewDraftInput.parse(input);
    const row = await reviewNudge(getDb(), ctx, {
      suggestionId: parsed.suggestionId,
      action: "rejected",
    });
    revalidatePath("/app/inbox");
    return { ok: true, id: row.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível dispensar o alerta.") };
  }
}
