import type { ChannelEvent } from "@crm/channels";
import type { DbExecutor } from "@crm/db";
import { emitDomainEvent, schema } from "@crm/db";
import { eq } from "drizzle-orm";

import { completeStepInTx } from "../onboarding";
import type { ConnectionRef, IngestDeps, IngestedEvent } from "./ingest-events";
import type { ContactRow, ConversationRow, MessageRow } from "./repository";
import {
  applyInboundStatusTransition,
  findOrCreateTicket,
  insertMessage,
  messagePreviewText,
  updateConversationLastMessage,
  upsertContact,
} from "./repository";

const { conversations } = schema;

/** Re-pull a missing contact photo at most weekly (contacts may add one later). */
const AVATAR_HEAL_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

type ReceivedEvent = Extract<ChannelEvent, { type: "message.received" }>;

/**
 * Avatar heal: enqueue when the contact has no photo and the last attempt is
 * stale — covers both first-touch and lazy re-pull.
 */
async function enqueueAvatarHeal(
  executor: DbExecutor,
  conn: ConnectionRef,
  { contact, deps }: { contact: ContactRow; deps?: IngestDeps },
): Promise<void> {
  const avatarFetchedAt = contact.metadata.avatarFetchedAt;
  const avatarStale =
    typeof avatarFetchedAt !== "string" ||
    Date.now() - Date.parse(avatarFetchedAt) > AVATAR_HEAL_AFTER_MS;
  if (contact.avatarUrl || !avatarStale) return;
  await deps?.enqueueAvatar?.(executor, {
    organizationId: conn.organizationId,
    contactId: contact.id,
    channelConnectionId: conn.id,
    channelUserId: contact.channelUserId,
  });
}

/**
 * Media event without a fetchable source — the row stays real but the
 * bubble shows an internal "unsupported file" note, never a broken <img>.
 */
function unsupportedMediaMetadata(content: ReceivedEvent["content"]) {
  const unsupported =
    content.type === "media" && content.source.type === "url" && !content.source.url;
  return unsupported ? { metadata: { unsupportedMedia: true } } : {};
}

/**
 * Inbound voice/audio → STT job (no-op without an audio-capable BYOK
 * credential; spec channel-whatsapp.md §5). Atomic with the insert.
 */
async function enqueueTranscribeIfAudio(
  executor: DbExecutor,
  conn: ConnectionRef,
  {
    content,
    messageId,
    deps,
  }: { content: ReceivedEvent["content"]; messageId: string; deps?: IngestDeps },
): Promise<void> {
  if (content.type !== "media" || content.mediaKind !== "audio") return;
  if (content.source.type !== "url") return;
  await deps?.enqueueTranscribe?.(executor, {
    organizationId: conn.organizationId,
    messageId,
    channelConnectionId: conn.id,
  });
}

type ReceivedContext = {
  event: ReceivedEvent;
  conversation: ConversationRow;
  created: boolean;
};

/** Replayed webhook: nothing was inserted, so nothing fans out. */
async function discardReplay(
  executor: DbExecutor,
  { event, conversation, created }: ReceivedContext,
): Promise<IngestedEvent> {
  if (created) {
    // Replayed webhook on a resolved chat: the follow-up ticket was
    // created before the deduped insert — drop the empty ticket so a
    // replay can't manufacture a phantom ticket.
    await executor.delete(conversations).where(eq(conversations.id, conversation.id));
  }
  return { eventType: event.type, messageId: null };
}

async function announceNewTicket(
  executor: DbExecutor,
  conn: ConnectionRef,
  { conversation, contactId }: { conversation: ConversationRow; contactId: string },
): Promise<void> {
  await completeStepInTx(executor, conn.organizationId, "first_conversation");
  await emitDomainEvent(executor, {
    type: "conversation.created",
    organizationId: conn.organizationId,
    conversationId: conversation.id,
    contactId,
    ticketNumber: conversation.ticketNumber,
    precededById: conversation.precededById,
  });
}

/**
 * Fan out only for a real insert — webhook replays return no row and must
 * not re-notify nor re-run the status transition. pg_notify fires on
 * commit with the write tx; the job row lands in the same tx.
 */
async function fanOutReceived(
  executor: DbExecutor,
  conn: ConnectionRef,
  {
    received,
    contact,
    message,
    deps,
  }: { received: ReceivedContext; contact: ContactRow; message: MessageRow; deps?: IngestDeps },
): Promise<IngestedEvent> {
  const { event, conversation, created } = received;
  await enqueueTranscribeIfAudio(executor, conn, {
    content: event.content,
    messageId: message.id,
    deps,
  });
  const transitioned = await applyInboundStatusTransition(
    executor,
    conversation.id,
    conversation.status,
  );
  if (created) await announceNewTicket(executor, conn, { conversation, contactId: contact.id });
  await emitDomainEvent(executor, {
    type: "message.received",
    organizationId: conn.organizationId,
    conversationId: conversation.id,
    messageId: message.id,
    contactId: contact.id,
    sentAt: event.timestamp.toISOString(),
  });
  if (transitioned) {
    await emitDomainEvent(executor, {
      type: "conversation.updated",
      organizationId: conn.organizationId,
      conversationId: conversation.id,
      status: transitioned.status,
    });
  }
  await deps?.enqueue?.(executor, {
    organizationId: conn.organizationId,
    channelConnectionId: conn.id,
    eventType: event.type,
    conversationId: conversation.id,
    messageId: message.id,
  });
  return { eventType: event.type, messageId: message.id };
}

/**
 * Pure domain ingest — no HTTP. Runs inside the caller's withTenant
 * transaction. `conn` identity always comes from the stored connection row,
 * never from the event payload.
 */
export async function ingestMessageReceived(
  executor: DbExecutor,
  conn: ConnectionRef,
  { event, deps }: { event: ReceivedEvent; deps?: IngestDeps },
): Promise<IngestedEvent> {
  const contact = await upsertContact(executor, conn.organizationId, {
    channelUserId: event.from.channelUserId,
    displayName: event.from.displayName,
  });
  await enqueueAvatarHeal(executor, conn, { contact, deps });
  const { conversation, created } = await findOrCreateTicket(executor, {
    organizationId: conn.organizationId,
    channelConnectionId: conn.id,
    contactId: contact.id,
    externalId: event.from.channelUserId,
  });
  const message = await insertMessage(executor, {
    organizationId: conn.organizationId,
    conversationId: conversation.id,
    channelConnectionId: conn.id,
    contactId: contact.id,
    direction: "inbound",
    content: event.content,
    externalId: event.externalMessageId,
    status: "received",
    sentAt: event.timestamp,
    ...unsupportedMediaMetadata(event.content),
  });
  await updateConversationLastMessage(executor, conversation.id, {
    lastMessageAt: event.timestamp,
    lastMessage: {
      direction: "inbound",
      preview: messagePreviewText(event.content),
    },
  });
  const received = { event, conversation, created };
  if (!message) return discardReplay(executor, received);
  return fanOutReceived(executor, conn, { received, contact, message, deps });
}
