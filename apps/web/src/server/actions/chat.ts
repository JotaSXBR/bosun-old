"use server";

// Chat-level channel actions — reactions, edits, deletes, presence and
// media uploads (file → object storage → signed URL → provider fetch).
import { DomainError } from "@crm/core";
import type {
  ConversationIdInput,
  EditMessageInput,
  MessageActionInput,
  PresenceInput,
  ReactMessageInput,
  SendChannelInput,
} from "@crm/core/messaging";
import {
  deleteMessageContent,
  editMessageContent,
  getMessageContent,
  getMessageEdits,
  reactToMessage,
  resendFailedMessage,
  sendChannelMessage,
  sendChatPresence,
  subscribeChatPresence,
} from "@crm/core/messaging";
import { getDb } from "@crm/db";
import { captureException } from "@crm/observability";
import { tenantObjectKey } from "@crm/storage";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { mediaKindOf, parseMediaForm } from "@/lib/media-upload";
import { getStorage } from "@/server/storage";
import { requireTenantContext } from "@/server/tenant";

const SIGNED_URL_TTL_SECONDS = 3600;

export type ChatActionResult =
  { ok: true; id: string } | { ok: true } | { ok: false; error: string };

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? fallback;
  }
  if (error instanceof DomainError) {
    return error.message;
  }
  captureException(error, { action: "chat" });
  return fallback;
}

export async function sendChannelMessageAction(input: SendChannelInput): Promise<ChatActionResult> {
  const ctx = await requireTenantContext();
  try {
    const message = await sendChannelMessage(getDb(), ctx, { input });
    revalidatePath("/app/inbox");
    return { ok: true, id: message.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível enviar a mensagem.") };
  }
}

/** Stores the file under the tenant key and returns it with the signed GET URL the provider downloads. */
async function uploadOutbound(organizationId: string, file: File, mime: string) {
  const storage = getStorage();
  const storageKey = tenantObjectKey(organizationId, "outbound", crypto.randomUUID());
  await storage.upload({
    key: storageKey,
    body: new Uint8Array(await file.arrayBuffer()),
    contentType: mime,
  });
  const url = await storage.getSignedUrl(storageKey, {
    method: "get",
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
  });
  return { storageKey, url };
}

/**
 * Upload + send in one action: the file lands in object storage under the
 * tenant key, a signed GET URL is what the provider downloads. The object
 * key is persisted on the message so the media proxy can re-serve it after
 * the signed URL expires.
 */
export async function sendMediaMessageAction(formData: FormData): Promise<ChatActionResult> {
  const ctx = await requireTenantContext();
  try {
    const { input, file } = parseMediaForm(formData);
    const mime = file.type || "application/octet-stream";
    const { storageKey, url } = await uploadOutbound(ctx.organizationId, file, mime);

    const message = await sendChannelMessage(getDb(), ctx, {
      input: {
        conversationId: input.conversationId,
        content: {
          type: "media",
          mediaKind: mediaKindOf(mime, input.voiceNote),
          url,
          mimeType: mime,
          ...(input.caption ? { caption: input.caption } : {}),
          filename: file.name,
          ...(input.voiceNote ? { voiceNote: true } : {}),
          storageKey,
        },
        ...(input.replyToId ? { replyToId: input.replyToId } : {}),
      },
    });
    revalidatePath("/app/inbox");
    return { ok: true, id: message.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível enviar o arquivo.") };
  }
}

/**
 * Retries a failed outbound message in place. Media re-signs the stored
 * upload key — the original signed URL is long expired by the time an
 * agent hits "reenviar".
 */
export async function resendMessageAction(input: MessageActionInput): Promise<ChatActionResult> {
  const ctx = await requireTenantContext();
  try {
    const storage = getStorage();
    const message = await resendFailedMessage(getDb(), ctx, {
      input,
      deps: {
        signUrl: (storageKey) =>
          storage.getSignedUrl(storageKey, {
            method: "get",
            expiresInSeconds: SIGNED_URL_TTL_SECONDS,
          }),
      },
    });
    revalidatePath("/app/inbox");
    return { ok: true, id: message.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível reenviar a mensagem.") };
  }
}

export async function reactToMessageAction(input: ReactMessageInput): Promise<ChatActionResult> {
  const ctx = await requireTenantContext();
  try {
    await reactToMessage(getDb(), ctx, { input });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível reagir.") };
  }
}

export async function editMessageAction(input: EditMessageInput): Promise<ChatActionResult> {
  const ctx = await requireTenantContext();
  try {
    await editMessageContent(getDb(), ctx, { input });
    revalidatePath("/app/inbox");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível editar a mensagem.") };
  }
}

export async function deleteMessageAction(input: MessageActionInput): Promise<ChatActionResult> {
  const ctx = await requireTenantContext();
  try {
    await deleteMessageContent(getDb(), ctx, { input });
    revalidatePath("/app/inbox");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível apagar a mensagem.") };
  }
}

/** Transient — presence failures are silent, nothing to revalidate. */
export async function sendChatPresenceAction(input: PresenceInput): Promise<ChatActionResult> {
  const ctx = await requireTenantContext();
  try {
    await sendChatPresence(getDb(), ctx, { input });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "presence") };
  }
}

/** Fired when a conversation opens — subscribes to contact presence. */
export async function subscribeChatPresenceAction(
  input: ConversationIdInput,
): Promise<ChatActionResult> {
  const ctx = await requireTenantContext();
  try {
    await subscribeChatPresence(getDb(), ctx, { input });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "subscribe") };
  }
}

/** Privileged: unredacted content behind the revoked placeholder. */
export async function getMessageOriginalAction(
  input: MessageActionInput,
): Promise<{ ok: true; text: string | null } | { ok: false; error: string }> {
  const ctx = await requireTenantContext();
  try {
    const { content } = await getMessageContent(getDb(), ctx, input);
    const text =
      typeof content === "object" && content !== null
        ? (((content as Record<string, unknown>).text as string | undefined) ??
          ((content as Record<string, unknown>).caption as string | undefined) ??
          null)
        : null;
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível carregar o original.") };
  }
}

/** Privileged: previous versions of an edited message. */
export async function listMessageEditsAction(input: MessageActionInput): Promise<
  | {
      ok: true;
      edits: { previousText: string | null; editedByUserId: string | null; createdAt: string }[];
    }
  | { ok: false; error: string }
> {
  const ctx = await requireTenantContext();
  try {
    const rows = await getMessageEdits(getDb(), ctx, input);
    return {
      ok: true,
      edits: rows.map((row) => {
        const content = row.previousContent as Record<string, unknown> | null;
        const previousText =
          (content?.text as string | undefined) ?? (content?.caption as string | undefined) ?? null;
        return {
          previousText,
          editedByUserId: row.editedByUserId,
          createdAt: row.createdAt.toISOString(),
        };
      }),
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível carregar o histórico.") };
  }
}
