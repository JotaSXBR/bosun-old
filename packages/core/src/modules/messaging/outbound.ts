// Outbound actions — agent replies through the channel provider and private
// internal notes. Ticket guards live in ./actions (module-internal exports).
import type { ChannelProvider, SendMessageResult } from "@crm/channels";
import { providerForConnection } from "@crm/core/integrations";
import type { Database } from "@crm/db";
import { emitDomainEvent, withTenant } from "@crm/db";
import { captureException } from "@crm/observability";

import { DomainError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { assertTicketOwner, loadActiveTicket } from "./actions";
import type { ConversationRow, OutboundContent } from "./outbound-shared";
import { recordAgentReply } from "./outbound-shared";
import type { MessageRow } from "./repository";
import { insertMessage } from "./repository";
import type { InternalNoteInput, SendChannelInput, SendOutboundInput } from "./schemas";
import { internalNoteInput, sendChannelInput, sendOutboundInput } from "./schemas";

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

type SendDeps = { provider?: ChannelProvider; automated?: boolean };

function toOutboundContent(input: ReturnType<typeof sendChannelInput.parse>["content"]) {
  if (input.type === "text") return input;
  return {
    type: "media" as const,
    mediaKind: input.mediaKind,
    source: { type: "url" as const, url: input.url },
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(input.caption ? { caption: input.caption } : {}),
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.voiceNote ? { voiceNote: true } : {}),
    ...(input.storageKey ? { storageKey: input.storageKey } : {}),
  };
}

/** Sends through the provider; a failure keeps a `failed` row as audit trail and throws SEND_FAILED. */
async function sendOrRecordFailure(
  db: Database,
  ctx: TenantContext,
  {
    provider,
    conversation,
    content,
    options,
  }: {
    provider: ChannelProvider;
    conversation: ConversationRow;
    content: ReturnType<typeof toOutboundContent>;
    options: { replyToId?: string; automated?: boolean };
  },
): Promise<SendMessageResult> {
  try {
    // Automated sends (off-hours, draft approval) get the anti-ban envelope:
    // seen → typing ∝ length → paused → send. Human sends stay bare — the
    // human's blue tick is the read signal fired by markConversationRead,
    // never a side effect of replying (spec: seen = read, not reply).
    if (options.automated && content.type === "text") {
      return await sendWithEnvelope(provider, conversation.externalId, content.text);
    }
    return await provider.sendMessage({
      to: conversation.externalId,
      content,
      ...(options.replyToId ? { replyToId: options.replyToId } : {}),
    });
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
}

async function persistSentMessage(
  db: Database,
  ctx: TenantContext,
  {
    conversation,
    content,
    sent,
  }: { conversation: ConversationRow; content: OutboundContent; sent: SendMessageResult },
): Promise<MessageRow> {
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
      externalId: sent.externalId,
      status: sent.status,
      sentAt: now,
      authorId: ctx.userId,
    });
    if (!message) throw new Error("outbound message insert raced");
    await recordAgentReply(tx, ctx, { conversation, current, content, now });
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

export { resendFailedMessage } from "./outbound-resend";

/**
 * Requires messaging:write. Sends a channel message (text or media already
 * uploaded to storage — `content.url` is the signed GET the provider
 * fetches) through the provider, then persists it. `replyToId` quotes a
 * message on the remote side.
 */
export async function sendChannelMessage(
  db: Database,
  ctx: TenantContext,
  { input, deps }: { input: SendChannelInput; deps?: SendDeps },
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
  const content = toOutboundContent(parsed.content);
  const options = { replyToId: parsed.replyToId, automated: deps?.automated };
  const sent = await sendOrRecordFailure(db, ctx, { provider, conversation, content, options });
  return persistSentMessage(db, ctx, { conversation, content, sent });
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
