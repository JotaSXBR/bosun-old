// Outbound actions — agent replies through the channel provider and private
// internal notes. Ticket guards live in ./actions (module-internal exports).
import type { ChannelProvider, OutboundMessage, SendMessageResult } from "@crm/channels";
import { providerForConnection } from "@crm/core/integrations";
import type { Database } from "@crm/db";
import { emitDomainEvent, withTenant } from "@crm/db";
import { captureException } from "@crm/observability";

import { DomainError, NotFoundError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { assertTicketOwner, loadActiveTicket, patchTicket } from "./actions";
import type { MessageRow } from "./repository";
import {
  insertMessage,
  messagePreviewText,
  updateConversationLastMessage,
  upsertConversationRead,
} from "./repository";
import { getMessage, markMessageSent } from "./repository-messages";
import type {
  InternalNoteInput,
  MessageActionInput,
  SendChannelInput,
  SendOutboundInput,
} from "./schemas";
import {
  internalNoteInput,
  messageActionInput,
  sendChannelInput,
  sendOutboundInput,
} from "./schemas";

/**
 * Anti-ban envelope for AUTOMATED sends (off-hours reply, draft approval —
 * spec channel-whatsapp.md §9): mark the chat seen, simulate typing
 * proportional to the text, pause, then send. Presence/seen failures are
 * best-effort — they must never block or fail the send itself.
 */
export async function sendWithEnvelope(
  provider: ChannelProvider,
  chatId: string,
  text: string,
): Promise<SendMessageResult> {
  const swallow = (error: unknown) => captureException(error, { op: "sendWithEnvelope", chatId });
  await provider.sendSeen?.(chatId).catch(swallow);
  if (provider.sendPresence) {
    await provider.sendPresence(chatId, "typing").catch(swallow);
    const delayMs = Math.min(Math.max(text.length * 120, 1000), 4000);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await provider.sendPresence(chatId, "paused").catch(swallow);
  }
  return provider.sendMessage({ to: chatId, content: { type: "text", text } });
}

/**
 * Requires messaging:write. Sends an agent reply through the channel provider.
 *
 * Ordering is deliberate: the provider call happens OUTSIDE any DB
 * transaction (a slow/failing provider must not hold row locks), then the
 * persisted state is written in a second tx. Known v1 gap: provider-send
 * succeeded + write failed leaves the customer message unrecorded — accepted
 * and documented; webhook status events still reconcile by externalId.
 *
 * Side effects on success: reply is persisted (authorId = caller), ticket
 * goes to waiting_customer, auto-assigns the caller when unassigned, and
 * first_response_at is stamped once. On provider failure a `failed` message
 * row is kept as an audit trail and SEND_FAILED is thrown.
 */
export async function sendOutboundMessage(
  db: Database,
  ctx: TenantContext,
  {
    input,
    deps,
  }: { input: SendOutboundInput; deps?: { provider?: ChannelProvider; automated?: boolean } },
): Promise<MessageRow> {
  const parsed = sendOutboundInput.parse(input);
  return sendChannelMessage(db, ctx, {
    input: { conversationId: parsed.conversationId, content: { type: "text", text: parsed.text } },
    deps,
  });
}

/**
 * Requires messaging:write. Sends a channel message (text or media already
 * uploaded to storage — `content.url` is the signed GET the provider
 * fetches) through the provider, then persists it. `replyToId` quotes a
 * message on the remote side.
 */
export async function sendChannelMessage(
  db: Database,
  ctx: TenantContext,
  {
    input,
    deps,
  }: { input: SendChannelInput; deps?: { provider?: ChannelProvider; automated?: boolean } },
): Promise<MessageRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const parsed = sendChannelInput.parse(input);
  const conversation = await withTenant(db, ctx.organizationId, (tx) =>
    loadActiveTicket(tx, parsed.conversationId),
  );
  assertTicketOwner(conversation, ctx);
  const provider =
    deps?.provider ??
    (await providerForConnection(db, ctx.organizationId, conversation.channelConnectionId));

  const content =
    parsed.content.type === "text"
      ? parsed.content
      : {
          type: "media" as const,
          mediaKind: parsed.content.mediaKind,
          source: { type: "url" as const, url: parsed.content.url },
          ...(parsed.content.mimeType ? { mimeType: parsed.content.mimeType } : {}),
          ...(parsed.content.caption ? { caption: parsed.content.caption } : {}),
          ...(parsed.content.filename ? { filename: parsed.content.filename } : {}),
          ...(parsed.content.voiceNote ? { voiceNote: true } : {}),
          ...(parsed.content.storageKey ? { storageKey: parsed.content.storageKey } : {}),
        };
  let externalId: string;
  let status: string;
  try {
    // Automated sends (off-hours, draft approval) get the anti-ban envelope:
    // seen → typing ∝ length → paused → send. Human sends stay bare — the
    // human's blue tick is the read signal fired by markConversationRead,
    // never a side effect of replying (spec: seen = read, not reply).
    const sent =
      deps?.automated && content.type === "text"
        ? await sendWithEnvelope(provider, conversation.externalId, content.text)
        : await provider.sendMessage({
            to: conversation.externalId,
            content,
            ...(parsed.replyToId ? { replyToId: parsed.replyToId } : {}),
          });
    externalId = sent.externalId;
    status = sent.status;
  } catch (cause) {
    await withTenant(db, ctx.organizationId, (tx) =>
      insertMessage(tx, {
        organizationId: ctx.organizationId,
        conversationId: conversation.id,
        channelConnectionId: conversation.channelConnectionId,
        contactId: conversation.contactId,
        direction: "outbound",
        content,
        externalId: null,
        status: "failed",
        sentAt: new Date(),
        authorId: ctx.userId,
      }),
    );
    throw new DomainError(
      "SEND_FAILED",
      `Provider failed to send the message: ${(cause as Error).message}`,
    );
  }

  const now = new Date();
  return withTenant(db, ctx.organizationId, async (tx) => {
    // The ticket may have been resolved while the provider call was in
    // flight — re-check inside the write tx before mutating it.
    const current = await loadActiveTicket(tx, conversation.id);
    const message = await insertMessage(tx, {
      organizationId: ctx.organizationId,
      conversationId: conversation.id,
      channelConnectionId: conversation.channelConnectionId,
      contactId: conversation.contactId,
      direction: "outbound",
      content,
      externalId,
      status,
      sentAt: now,
      authorId: ctx.userId,
    });
    if (!message) throw new Error("outbound message insert raced");
    await updateConversationLastMessage(tx, conversation.id, {
      lastMessageAt: now,
      lastMessage: {
        direction: "outbound",
        preview: messagePreviewText(content),
      },
    });
    await patchTicket(tx, ctx.organizationId, {
      conversationId: conversation.id,
      patch: {
        status: "waiting_customer",
        assigneeId: current.assigneeId ?? ctx.userId,
        firstResponseAt: current.firstResponseAt ?? now,
      },
    });
    // Sending implies the author saw the thread — bump their read cursor.
    await upsertConversationRead(tx, {
      organizationId: ctx.organizationId,
      conversationId: conversation.id,
      userId: ctx.userId,
    });
    await emitDomainEvent(tx, {
      type: "message.sent",
      organizationId: ctx.organizationId,
      conversationId: conversation.id,
      messageId: message.id,
      authorId: ctx.userId,
      sentAt: now.toISOString(),
    });
    return message;
  });
}

/**
 * Requires messaging:write. Resends a `failed` outbound message through the
 * same row — the bubble flips to sent, no duplicate appears. Media resends
 * need `deps.signUrl`: the persisted storage key yields a fresh signed GET
 * (the original `source.url` expires after the send TTL).
 */
export async function resendFailedMessage(
  db: Database,
  ctx: TenantContext,
  {
    input,
    deps,
  }: {
    input: MessageActionInput;
    deps?: { provider?: ChannelProvider; signUrl?: (storageKey: string) => Promise<string> };
  },
): Promise<MessageRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const parsed = messageActionInput.parse(input);
  const { conversation, message } = await withTenant(db, ctx.organizationId, async (tx) => {
    const conv = await loadActiveTicket(tx, parsed.conversationId);
    assertTicketOwner(conv, ctx);
    const msg = await getMessage(tx, parsed.messageId);
    if (msg?.conversationId !== conv.id) {
      throw new NotFoundError("Message", parsed.messageId);
    }
    if (msg.direction !== "outbound" || msg.status !== "failed" || msg.private) {
      throw new DomainError(
        "MESSAGE_NOT_RESENDABLE",
        "Only failed outbound messages can be resent.",
      );
    }
    return { conversation: conv, message: msg };
  });
  const provider =
    deps?.provider ??
    (await providerForConnection(db, ctx.organizationId, conversation.channelConnectionId));

  const stored = message.content as OutboundMessage["content"];
  let content: OutboundMessage["content"] = stored;
  if (stored.type === "media") {
    if (!stored.storageKey || !deps?.signUrl) {
      throw new DomainError(
        "MESSAGE_NOT_RESENDABLE",
        "Media resend requires the stored upload (storageKey).",
      );
    }
    content = {
      ...stored,
      source: { type: "url", url: await deps.signUrl(stored.storageKey) },
    };
  }

  let sent: SendMessageResult;
  try {
    sent = await provider.sendMessage({ to: conversation.externalId, content });
  } catch (cause) {
    throw new DomainError(
      "SEND_FAILED",
      `Provider failed to resend the message: ${(cause as Error).message}`,
    );
  }

  const now = new Date();
  return withTenant(db, ctx.organizationId, async (tx) => {
    const current = await loadActiveTicket(tx, conversation.id);
    const updated = await markMessageSent(tx, message.id, {
      externalId: sent.externalId,
      status: sent.status,
      sentAt: now,
    });
    if (!updated) throw new Error("resend status raced — message no longer failed");
    await updateConversationLastMessage(tx, conversation.id, {
      lastMessageAt: now,
      lastMessage: {
        direction: "outbound",
        preview: messagePreviewText(content),
      },
    });
    await patchTicket(tx, ctx.organizationId, {
      conversationId: conversation.id,
      patch: {
        status: "waiting_customer",
        assigneeId: current.assigneeId ?? ctx.userId,
        firstResponseAt: current.firstResponseAt ?? now,
      },
    });
    await upsertConversationRead(tx, {
      organizationId: ctx.organizationId,
      conversationId: conversation.id,
      userId: ctx.userId,
    });
    await emitDomainEvent(tx, {
      type: "message.updated",
      organizationId: ctx.organizationId,
      conversationId: conversation.id,
      messageId: updated.id,
    });
    return updated;
  });
}

/**
 * Requires messaging:write. Internal note — a private outbound-direction
 * message that is never sent to the provider. Resolved tickets reject it.
 */
export async function addInternalNote(
  db: Database,
  ctx: TenantContext,
  input: InternalNoteInput,
): Promise<MessageRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const parsed = internalNoteInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    const conversation = await loadActiveTicket(tx, parsed.conversationId);
    assertTicketOwner(conversation, ctx);
    const note = await insertMessage(tx, {
      organizationId: ctx.organizationId,
      conversationId: conversation.id,
      channelConnectionId: conversation.channelConnectionId,
      contactId: null,
      direction: "outbound",
      content: { type: "text", text: parsed.text },
      externalId: null,
      status: "sent",
      sentAt: new Date(),
      private: true,
      authorId: ctx.userId,
    });
    if (!note) throw new Error("internal note insert raced");
    await emitDomainEvent(tx, {
      type: "message.created",
      organizationId: ctx.organizationId,
      conversationId: conversation.id,
      messageId: note.id,
      authorId: ctx.userId,
      private: true,
    });
    return note;
  });
}
