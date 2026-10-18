"use server";

import { enqueueObserverAnalyze } from "@crm/automation";
import { DomainError } from "@crm/core";
import type {
  ConversationIdInput,
  InternalNoteInput,
  MessageSearchHit,
  SendOutboundInput,
  SnoozeConversationInput,
  TransferConversationInput,
} from "@crm/core/messaging";
import {
  addInternalNote,
  markConversationRead,
  pickupConversation,
  reopenTicket,
  resolveConversation,
  resumeTicket,
  searchConversationMessages,
  sendOutboundMessage,
  setConversationInProgress,
  setConversationSnooze,
  setConversationWaiting,
  transferConversation,
} from "@crm/core/messaging";
import { getDb } from "@crm/db";
import { captureException } from "@crm/observability";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireTenantContext } from "@/server/tenant";

export type MessagingActionResult = { ok: true; id: string } | { ok: false; error: string };

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? fallback;
  }
  if (error instanceof DomainError) {
    return error.message;
  }
  captureException(error, { action: "messaging" });
  return fallback;
}

function revalidateInbox(): void {
  revalidatePath("/app/inbox");
}

export async function pickupConversationAction(
  input: ConversationIdInput,
): Promise<MessagingActionResult> {
  const ctx = await requireTenantContext();
  try {
    const conv = await pickupConversation(getDb(), ctx, { input });
    revalidateInbox();
    return { ok: true, id: conv.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível assumir o ticket.") };
  }
}

export async function transferConversationAction(
  input: TransferConversationInput,
): Promise<MessagingActionResult> {
  const ctx = await requireTenantContext();
  try {
    const conv = await transferConversation(getDb(), ctx, input);
    revalidateInbox();
    return { ok: true, id: conv.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível transferir o ticket.") };
  }
}

export async function resolveConversationAction(
  input: ConversationIdInput,
): Promise<MessagingActionResult> {
  const ctx = await requireTenantContext();
  try {
    const conv = await resolveConversation(getDb(), ctx, {
      input,
      deps: {
        enqueue: (executor, payload) => enqueueObserverAnalyze(payload, executor),
      },
    });
    revalidateInbox();
    return { ok: true, id: conv.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível resolver o ticket.") };
  }
}

export async function setConversationWaitingAction(
  input: ConversationIdInput,
): Promise<MessagingActionResult> {
  const ctx = await requireTenantContext();
  try {
    const conv = await setConversationWaiting(getDb(), ctx, input);
    revalidateInbox();
    return { ok: true, id: conv.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível marcar como aguardando.") };
  }
}

export async function setConversationInProgressAction(
  input: ConversationIdInput,
): Promise<MessagingActionResult> {
  const ctx = await requireTenantContext();
  try {
    const conv = await setConversationInProgress(getDb(), ctx, input);
    revalidateInbox();
    return { ok: true, id: conv.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível retomar o atendimento.") };
  }
}

export async function snoozeConversationAction(
  input: SnoozeConversationInput,
): Promise<MessagingActionResult> {
  const ctx = await requireTenantContext();
  try {
    const conv = await setConversationSnooze(getDb(), ctx, input);
    revalidateInbox();
    return { ok: true, id: conv.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível adiar o ticket.") };
  }
}

export async function sendOutboundMessageAction(
  input: SendOutboundInput,
): Promise<MessagingActionResult> {
  const ctx = await requireTenantContext();
  try {
    const message = await sendOutboundMessage(getDb(), ctx, { input });
    revalidateInbox();
    return { ok: true, id: message.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível enviar a mensagem.") };
  }
}

export async function addInternalNoteAction(
  input: InternalNoteInput,
): Promise<MessagingActionResult> {
  const ctx = await requireTenantContext();
  try {
    const note = await addInternalNote(getDb(), ctx, input);
    revalidateInbox();
    return { ok: true, id: note.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível salvar a nota interna.") };
  }
}

export async function reopenTicketAction(
  input: ConversationIdInput,
): Promise<MessagingActionResult> {
  const ctx = await requireTenantContext();
  try {
    const conv = await reopenTicket(getDb(), ctx, input);
    revalidateInbox();
    return { ok: true, id: conv.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível reabrir o ticket.") };
  }
}

/**
 * Bumps the caller's read cursor — fired by the pane's client marker
 * (plan 2) and implicitly inside sendOutboundMessage. No revalidate:
 * unread badges update via SSE refresh, not a fresh render.
 */
export async function markConversationReadAction(
  input: ConversationIdInput,
): Promise<MessagingActionResult> {
  const ctx = await requireTenantContext();
  try {
    await markConversationRead(getDb(), ctx, { input });
    return { ok: true, id: input.conversationId };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível marcar como lido.") };
  }
}

export async function resumeTicketAction(
  input: ConversationIdInput,
): Promise<MessagingActionResult> {
  const ctx = await requireTenantContext();
  try {
    const ticket = await resumeTicket(getDb(), ctx, input);
    revalidateInbox();
    return { ok: true, id: ticket.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível criar o follow-up.") };
  }
}

export type SearchMessagesResult =
  { ok: true; hits: MessageSearchHit[] } | { ok: false; error: string };

/** B1 header search — hit list for the dropdown; the jump re-renders via ?around. */
export async function searchMessagesAction(input: {
  conversationId: string;
  query: string;
}): Promise<SearchMessagesResult> {
  const ctx = await requireTenantContext();
  try {
    const hits = await searchConversationMessages(getDb(), ctx, input);
    return { ok: true, hits };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível buscar na conversa.") };
  }
}
