// Message-level outbound actions — reactions, edits, deletes and presence.
// Same guard stack as outbound sends: messaging:write + active ticket +
// assertTicketOwner. Provider calls run OUTSIDE db transactions (a slow
// provider must not hold row locks); local state commits after success.
import type { ChannelProvider, MessageContent } from "@crm/channels";
import { providerForConnection } from "@crm/core/integrations";
import type { Database } from "@crm/db";
import { emitDomainEvent, withTenant } from "@crm/db";

import { DomainError, NotFoundError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { assertTicketOwner, loadActiveTicket } from "./actions";
import type { MessageRow } from "./repository";
import {
  applyMessageEdit,
  getMessage,
  markMessageRevoked,
  refreshConversationLastMessage,
  upsertMessageReaction,
} from "./repository";
import type {
  ConversationIdInput,
  EditMessageInput,
  MessageActionInput,
  PresenceInput,
  ReactMessageInput,
} from "./schemas";
import {
  conversationIdInput,
  editMessageInput,
  messageActionInput,
  presenceInput,
  reactMessageInput,
} from "./schemas";

/** WhatsApp's own edit window — the remote rejects older messages anyway. */
const MESSAGE_EDIT_WINDOW_MS = 15 * 60_000;

type ProviderDeps = { provider?: ChannelProvider };

async function resolveProvider(
  db: Database,
  ctx: TenantContext,
  { channelConnectionId, deps }: { channelConnectionId: string; deps?: ProviderDeps },
): Promise<ChannelProvider> {
  return (
    deps?.provider ?? (await providerForConnection(db, ctx.organizationId, channelConnectionId))
  );
}

async function loadOwnedMessage(
  db: Database,
  ctx: TenantContext,
  { conversationId, messageId }: { conversationId: string; messageId: string },
): Promise<{ message: MessageRow; chatId: string }> {
  return withTenant(db, ctx.organizationId, async (tx) => {
    const conversation = await loadActiveTicket(tx, conversationId);
    assertTicketOwner(conversation, ctx);
    const message = await getMessage(tx, messageId);
    if (message?.conversationId !== conversation.id) {
      throw new NotFoundError("Message", messageId);
    }
    return { message, chatId: conversation.externalId };
  });
}

/**
 * Requires messaging:write. Reacts to a message on the channel ("" removes)
 * and upserts the local row — the webhook echo dedupes on reactor_key.
 */
export async function reactToMessage(
  db: Database,
  ctx: TenantContext,
  { input, deps }: { input: ReactMessageInput; deps?: ProviderDeps },
): Promise<void> {
  assertPermission(ctx, { messaging: ["write"] });
  const parsed = reactMessageInput.parse(input);
  const { message } = await loadOwnedMessage(db, ctx, {
    conversationId: parsed.conversationId,
    messageId: parsed.messageId,
  });
  if (!message.externalId) {
    throw new DomainError("MESSAGE_NOT_CHANNEL", "Only channel messages accept reactions");
  }
  const provider = await resolveProvider(db, ctx, {
    channelConnectionId: message.channelConnectionId,
    deps,
  });
  if (!provider.sendReaction) {
    throw new DomainError("CHANNEL_UNSUPPORTED_ACTION", "Provider does not support reactions");
  }
  await provider.sendReaction(message.externalId, parsed.emoji);
  await withTenant(db, ctx.organizationId, async (tx) => {
    await upsertMessageReaction(tx, {
      organizationId: ctx.organizationId,
      messageId: message.id,
      // The account is one reactor — "me" matches the webhook echo's key
      // (fromMe) so the echo dedupes onto this row instead of doubling it.
      reactorKey: "me",
      emoji: parsed.emoji,
      actorUserId: ctx.userId,
      fromMe: true,
    });
    await emitDomainEvent(tx, {
      type: "message.updated",
      organizationId: ctx.organizationId,
      conversationId: message.conversationId,
      messageId: message.id,
    });
  });
}

/**
 * Requires messaging:write. Edits an own outbound channel message inside
 * the WhatsApp window (~15min) and records the previous content in
 * message_edits. The webhook echo dedupes on identical text.
 */
export async function editMessageContent(
  db: Database,
  ctx: TenantContext,
  { input, deps }: { input: EditMessageInput; deps?: ProviderDeps },
): Promise<void> {
  assertPermission(ctx, { messaging: ["write"] });
  const parsed = editMessageInput.parse(input);
  const { message, chatId } = await loadOwnedMessage(db, ctx, {
    conversationId: parsed.conversationId,
    messageId: parsed.messageId,
  });
  assertEditableMessage(message, { enforceEditWindow: true });
  const provider = await resolveProvider(db, ctx, {
    channelConnectionId: message.channelConnectionId,
    deps,
  });
  if (!provider.editMessage) {
    throw new DomainError("CHANNEL_UNSUPPORTED_ACTION", "Provider does not support edits");
  }
  await provider.editMessage(chatId, message.externalId!, parsed.text);
  // Preserve quotedExternalId — WA edits replace the text only.
  const newContent = { ...(message.content as MessageContent), text: parsed.text };
  await recordMessageEdit(db, ctx, { message, newContent });
}

async function recordMessageEdit(
  db: Database,
  ctx: TenantContext,
  { message, newContent }: { message: MessageRow; newContent: MessageContent },
): Promise<void> {
  await withTenant(db, ctx.organizationId, async (tx) => {
    await applyMessageEdit(tx, {
      organizationId: ctx.organizationId,
      messageId: message.id,
      previousContent: message.content,
      newContent,
      editedByUserId: ctx.userId,
    });
    await refreshConversationLastMessage(tx, message.conversationId);
    await emitDomainEvent(tx, {
      type: "message.updated",
      organizationId: ctx.organizationId,
      conversationId: message.conversationId,
      messageId: message.id,
    });
  });
}

function assertEditableMessage(
  message: MessageRow,
  { enforceEditWindow = false }: { enforceEditWindow?: boolean } = {},
): void {
  if (message.direction !== "outbound" || message.private || !message.externalId) {
    throw new DomainError("MESSAGE_NOT_EDITABLE", "Only own outbound channel messages can change");
  }
  if ((message.content as { type?: string }).type !== "text") {
    throw new DomainError("MESSAGE_NOT_EDITABLE", "Only text messages can be edited");
  }
  if (message.revokedAt) {
    throw new DomainError("MESSAGE_REVOKED", "Deleted messages cannot be edited");
  }
  // Only edits are time-boxed (WhatsApp ~15 min); delete-for-everyone has no such limit here.
  if (
    enforceEditWindow &&
    message.sentAt &&
    Date.now() - message.sentAt.getTime() > MESSAGE_EDIT_WINDOW_MS
  ) {
    throw new DomainError("EDIT_WINDOW_EXPIRED", "Messages can only be edited ~15min after send");
  }
}

/**
 * Requires messaging:write. Revokes an own outbound message "for everyone"
 * — content stays in Bosun (audit); the UI renders the placeholder.
 */
export async function deleteMessageContent(
  db: Database,
  ctx: TenantContext,
  { input, deps }: { input: MessageActionInput; deps?: ProviderDeps },
): Promise<void> {
  assertPermission(ctx, { messaging: ["write"] });
  const parsed = messageActionInput.parse(input);
  const { message, chatId } = await loadOwnedMessage(db, ctx, {
    conversationId: parsed.conversationId,
    messageId: parsed.messageId,
  });
  assertEditableMessage(message);
  const provider = await resolveProvider(db, ctx, {
    channelConnectionId: message.channelConnectionId,
    deps,
  });
  if (!provider.deleteMessage) {
    throw new DomainError("CHANNEL_UNSUPPORTED_ACTION", "Provider does not support deletes");
  }
  await provider.deleteMessage(chatId, message.externalId!);
  await withTenant(db, ctx.organizationId, async (tx) => {
    await markMessageRevoked(tx, message.channelConnectionId, message.externalId!);
    await refreshConversationLastMessage(tx, message.conversationId);
    await emitDomainEvent(tx, {
      type: "message.updated",
      organizationId: ctx.organizationId,
      conversationId: message.conversationId,
      messageId: message.id,
    });
  });
}

/**
 * Requires messaging:write. Emits typing/recording/paused to the remote —
 * transient, nothing persisted. typing/recording expire ~10s remote-side.
 */
export async function sendChatPresence(
  db: Database,
  ctx: TenantContext,
  { input, deps }: { input: PresenceInput; deps?: ProviderDeps },
): Promise<void> {
  assertPermission(ctx, { messaging: ["write"] });
  const parsed = presenceInput.parse(input);
  const conversation = await withTenant(db, ctx.organizationId, (tx) =>
    loadActiveTicket(tx, parsed.conversationId),
  );
  assertTicketOwner(conversation, ctx);
  const provider = await resolveProvider(db, ctx, {
    channelConnectionId: conversation.channelConnectionId,
    deps,
  });
  await provider.sendPresence?.(conversation.externalId, parsed.presence);
}

/**
 * Requires messaging:read — any agent viewing the chat may subscribe to the
 * contact's presence. Idempotent on the provider side.
 */
export async function subscribeChatPresence(
  db: Database,
  ctx: TenantContext,
  { input, deps }: { input: ConversationIdInput; deps?: ProviderDeps },
): Promise<void> {
  assertPermission(ctx, { messaging: ["read"] });
  const parsed = conversationIdInput.parse(input);
  const conversation = await withTenant(db, ctx.organizationId, (tx) =>
    loadActiveTicket(tx, parsed.conversationId),
  );
  const provider = await resolveProvider(db, ctx, {
    channelConnectionId: conversation.channelConnectionId,
    deps,
  });
  await provider.subscribePresence?.(conversation.externalId);
}
