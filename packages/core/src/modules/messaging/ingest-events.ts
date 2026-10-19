import type { ChannelEvent } from "@crm/channels";
import { applyConnectionStatus } from "@crm/core/integrations";
import type { DbExecutor } from "@crm/db";
import { emitDomainEvent } from "@crm/db";

import {
  applyMessageEdit,
  findActiveTicket,
  findMessageByExternalIds,
  markMessageRevoked,
  updateMessageStatus,
  upsertMessageReaction,
} from "./repository";

/**
 * Minimal connection identity needed for ingestion. The row was already
 * authenticated (unguessable webhook token + provider signature) before any
 * event reaches here.
 */
export type ConnectionRef = {
  id: string;
  organizationId: string;
  kind: string;
};

export type IngestedEvent = {
  eventType: ChannelEvent["type"];
  /** Set when the event created/updated a message row. */
  messageId: string | null;
};

export type WebhookIngestResult = {
  organizationId: string;
  channelConnectionId: string;
  processed: IngestedEvent[];
};

/**
 * Job enqueue callback injected by the app layer (`@crm/automation` lives
 * above core — dependency direction forbids importing it here). Called with
 * the ingest transaction so the job row commits atomically with the write.
 */
export type ChannelEventEnqueue = (
  executor: DbExecutor,
  payload: {
    organizationId: string;
    channelConnectionId: string;
    eventType: ChannelEvent["type"];
    conversationId?: string;
    messageId?: string;
  },
) => Promise<unknown>;

/**
 * Avatar-fetch enqueue injected by the app layer (same pattern as
 * ChannelEventEnqueue — automation lives above core).
 */
export type ContactAvatarEnqueue = (
  executor: DbExecutor,
  payload: {
    organizationId: string;
    contactId: string;
    channelConnectionId: string;
    channelUserId: string;
  },
) => Promise<unknown>;

/**
 * Audio-transcription enqueue injected by the app layer (same pattern as
 * enqueueAvatar — automation lives above core).
 */
export type TranscribeEnqueue = (
  executor: DbExecutor,
  payload: {
    organizationId: string;
    messageId: string;
    channelConnectionId: string;
  },
) => Promise<unknown>;

export type IngestDeps = {
  enqueue?: ChannelEventEnqueue;
  enqueueAvatar?: ContactAvatarEnqueue;
  enqueueTranscribe?: TranscribeEnqueue;
};

/** 'me' = reacted on the phone itself; otherwise the contact's jid. */
export async function ingestMessageReaction(
  executor: DbExecutor,
  conn: ConnectionRef,
  event: Extract<ChannelEvent, { type: "message.reaction" }>,
): Promise<IngestedEvent> {
  const message = await findMessageByExternalIds(executor, conn.id, [event.messageExternalId]);
  if (!message) return { eventType: event.type, messageId: null };
  const reactorKey = event.fromMe
    ? "me"
    : (event.actorChannelUserId ?? message.contactId ?? "unknown");
  await upsertMessageReaction(executor, {
    organizationId: conn.organizationId,
    messageId: message.id,
    reactorKey,
    emoji: event.emoji,
    actorChannelUserId: event.actorChannelUserId,
    fromMe: event.fromMe,
  });
  await emitDomainEvent(executor, {
    type: "message.updated",
    organizationId: conn.organizationId,
    conversationId: message.conversationId,
    messageId: message.id,
  });
  return { eventType: event.type, messageId: message.id };
}

export async function ingestMessageEdited(
  executor: DbExecutor,
  conn: ConnectionRef,
  event: Extract<ChannelEvent, { type: "message.edited" }>,
): Promise<IngestedEvent> {
  const message = await findMessageByExternalIds(executor, conn.id, event.messageExternalIds);
  if (!message) return { eventType: event.type, messageId: null };
  // Skip history when the stored text already matches — the echo of our
  // own edit (and webhook replays) dedupe here. Media edits carry the new
  // caption; the shape is preserved (mediaKind/source stay intact).
  const stored = message.content as { type?: string; text?: string; caption?: string };
  const storedText = stored.type === "media" ? stored.caption : stored.text;
  if (storedText === event.newText) {
    return { eventType: event.type, messageId: message.id };
  }
  await applyMessageEdit(executor, {
    organizationId: conn.organizationId,
    messageId: message.id,
    previousContent: message.content,
    newContent:
      stored.type === "media"
        ? { ...(message.content as Record<string, unknown>), caption: event.newText }
        : { type: "text", text: event.newText },
  });
  await emitDomainEvent(executor, {
    type: "message.updated",
    organizationId: conn.organizationId,
    conversationId: message.conversationId,
    messageId: message.id,
  });
  return { eventType: event.type, messageId: message.id };
}

export async function ingestMessageRevoked(
  executor: DbExecutor,
  conn: ConnectionRef,
  event: Extract<ChannelEvent, { type: "message.revoked" }>,
): Promise<IngestedEvent> {
  const message = await markMessageRevoked(executor, conn.id, event.messageExternalId);
  if (!message) return { eventType: event.type, messageId: null };
  await emitDomainEvent(executor, {
    type: "message.updated",
    organizationId: conn.organizationId,
    conversationId: message.conversationId,
    messageId: message.id,
  });
  return { eventType: event.type, messageId: message.id };
}

/**
 * Transient presence — resolve the active ticket and emit a notify-only
 * event; the client renders a short-lived "digitando…" without a refresh.
 */
export async function ingestContactPresence(
  executor: DbExecutor,
  conn: ConnectionRef,
  event: Extract<ChannelEvent, { type: "contact.presence" }>,
): Promise<IngestedEvent> {
  const conversation = await findActiveTicket(executor, conn.id, event.chatId);
  if (!conversation) return { eventType: event.type, messageId: null };
  await emitDomainEvent(executor, {
    type: "contact.presence",
    organizationId: conn.organizationId,
    conversationId: conversation.id,
    presence: event.presence,
    participant: event.participant,
  });
  return { eventType: event.type, messageId: null };
}

export async function ingestMessageStatus(
  executor: DbExecutor,
  conn: ConnectionRef,
  { event, deps }: { event: Extract<ChannelEvent, { type: "message.status" }>; deps?: IngestDeps },
): Promise<IngestedEvent> {
  const message = await updateMessageStatus(executor, conn.id, {
    externalId: event.externalMessageId,
    status: event.status,
  });
  await deps?.enqueue?.(executor, {
    organizationId: conn.organizationId,
    channelConnectionId: conn.id,
    eventType: event.type,
    ...(message ? { messageId: message.id } : {}),
  });
  return { eventType: event.type, messageId: message?.id ?? null };
}

export async function ingestConnectionStatus(
  executor: DbExecutor,
  conn: ConnectionRef,
  {
    event,
    deps,
  }: { event: Extract<ChannelEvent, { type: "connection.status" }>; deps?: IngestDeps },
): Promise<IngestedEvent> {
  await applyConnectionStatus(executor, conn.id, event.status);
  await deps?.enqueue?.(executor, {
    organizationId: conn.organizationId,
    channelConnectionId: conn.id,
    eventType: event.type,
  });
  return { eventType: event.type, messageId: null };
}
