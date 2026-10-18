// WAHA payload mappers — kept apart from the provider class so each file
// stays small. Everything here is pure (no fetch, no I/O). Schemas live in
// waha-schemas.ts and are re-exported from here.
import type { z } from "zod";

import type {
  ChannelEvent,
  ConnectionStatus,
  InboundChannelMessage,
  MessageContent,
  PresenceKind,
} from "../domain";
import {
  wahaAckSchema,
  wahaEditedSchema,
  wahaMessageSchema,
  wahaPresenceSchema,
  wahaReactionSchema,
  wahaRevokedSchema,
  wahaSessionStatusSchema,
} from "./waha-schemas";

export * from "./waha-schemas";

export function mapSessionStatus(status: string): ConnectionStatus {
  switch (status) {
    case "WORKING":
      return "connected";
    case "STARTING":
    case "SCAN_QR_CODE":
    case "PASSKEY_REQUIRED":
    case "PASSKEY_CONFIRMATION_REQUIRED":
      return "connecting";
    case "FAILED":
      return "error";
    default:
      return "disconnected";
  }
}

/** WAHA ack codes: -1 error, 0 pending, 1 server, 2 device, 3 read, 4 played. */
function mapAck(ack: number): "sent" | "delivered" | "read" | "failed" | null {
  switch (ack) {
    case -1:
      return "failed";
    case 1:
      return "sent";
    case 2:
      return "delivered";
    case 3:
    case 4:
      return "read";
    default:
      return null; // 0 = pending and unknown codes are ignored
  }
}

export function wahaToInbound(
  data: z.infer<typeof wahaMessageSchema>,
  fallbackTimestamp?: number,
): InboundChannelMessage {
  const displayName = data.notifyName ?? data._data?.Info?.PushName ?? undefined;
  return {
    externalMessageId: data.id,
    from: {
      channelUserId: data.from,
      ...(displayName ? { displayName } : {}),
    },
    content: wahaMessageContent(data),
    // payload ts is seconds; the envelope fallback is already milliseconds.
    timestamp: new Date(data.timestamp ? data.timestamp * 1000 : (fallbackTimestamp ?? 0)),
  };
}

export function wahaMessageToEvents(
  payload: unknown,
  timestamp: number | undefined,
): ChannelEvent[] {
  const message = wahaMessageSchema.safeParse(payload);
  if (!message.success || message.data.fromMe) return [];
  return [{ type: "message.received", ...wahaToInbound(message.data, timestamp) }];
}

function wahaMessageContent(data: z.infer<typeof wahaMessageSchema>): MessageContent {
  const quotedId = wahaQuotedExternalId(data);
  const quoted = quotedId ? { quotedExternalId: quotedId } : {};
  if (!data.hasMedia) return { type: "text", text: data.body ?? "", ...quoted };
  return wahaMediaContent(data, quoted);
}

/**
 * GOWS `replyTo.id` is the bare stanzaID while stored external ids are
 * "{fromMe}_{chatId}_{stanzaID}" — compose it. `replyTo.participant` names
 * the quoted author: equal to `from` ⇒ peer-authored (false_), otherwise
 * ours (true_). Missing participant defaults to the peer (common reply case).
 */
function wahaQuotedExternalId(data: z.infer<typeof wahaMessageSchema>): string | undefined {
  const stanza = data.replyTo?.id;
  if (!stanza) return undefined;
  if (stanza.includes("@")) return stanza; // already serialized (WEBJS)
  const chatId = data.id.split("_")[1];
  if (!chatId) return undefined;
  const peerAuthored = !data.replyTo?.participant || data.replyTo.participant === data.from;
  return `${peerAuthored ? "false" : "true"}_${chatId}_${stanza}`;
}

function wahaMediaContent(
  data: z.infer<typeof wahaMessageSchema>,
  quoted: { quotedExternalId?: string },
): MessageContent {
  const mimeType = data.mimetype ?? data.media?.mimetype;
  const filename = data.filename ?? data.media?.filename ?? undefined;
  return {
    type: "media",
    mediaKind: wahaMediaKind(mimeType),
    source: { type: "url", url: data.mediaUrl ?? data.media?.url ?? "" },
    ...(mimeType ? { mimeType } : {}),
    ...(filename ? { filename } : {}),
    ...(data.body ? { caption: data.body } : {}),
    ...quoted,
  };
}

function wahaMediaKind(
  mimeType: string | null | undefined,
): "image" | "video" | "audio" | "document" {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";
  return "document";
}

export function wahaAckToEvents(payload: unknown, timestamp: number | undefined): ChannelEvent[] {
  const ack = wahaAckSchema.safeParse(payload);
  if (!ack.success) return [];
  const status = mapAck(ack.data.ack);
  if (!status) return [];
  return [
    {
      type: "message.status",
      externalMessageId: ack.data.id,
      status,
      timestamp: new Date(timestamp ?? Date.now()),
    },
  ];
}

export function wahaSessionStatusToEvents(payload: unknown): ChannelEvent[] {
  const session = wahaSessionStatusSchema.safeParse(payload);
  if (!session.success) return [];
  return [{ type: "connection.status", status: mapSessionStatus(session.data.status) }];
}

export function wahaReactionToEvents(payload: unknown): ChannelEvent[] {
  const reaction = wahaReactionSchema.safeParse(payload);
  if (!reaction.success) return [];
  return [
    {
      type: "message.reaction",
      messageExternalId: reaction.data.reaction.messageId,
      emoji: reaction.data.reaction.text ?? "",
      actorChannelUserId: reaction.data.participant ?? reaction.data.from ?? null,
      fromMe: reaction.data.fromMe ?? false,
    },
  ];
}

export function wahaEditedToEvents(payload: unknown): ChannelEvent[] {
  const edited = wahaEditedSchema.safeParse(payload);
  if (!edited.success) return [];
  // The chat id is the middle segment of the action id.
  const chatId = edited.data.id.split("_")[1];
  if (!chatId) return [];
  const messageId = edited.data.editedMessageId;
  return [
    {
      type: "message.edited",
      messageExternalIds: [`true_${chatId}_${messageId}`, `false_${chatId}_${messageId}`],
      newText: edited.data.body ?? "",
    },
  ];
}

export function wahaRevokedToEvents(payload: unknown): ChannelEvent[] {
  const revoked = wahaRevokedSchema.safeParse(payload);
  if (!revoked.success) return [];
  const { before, after, revokedMessageId } = revoked.data;
  if (before?.id) {
    return [{ type: "message.revoked", messageExternalId: before.id }];
  }
  // GOWS: compose "{fromMe}_{chat}_{stanza}" — the revoke actor in `after` is
  // always the revoked message's author (delete-for-everyone is self-only).
  const chatId = after?.id?.split("_")[1];
  if (!chatId || !revokedMessageId) return [];
  const fromMe = after.fromMe === true ? "true" : "false";
  return [
    { type: "message.revoked", messageExternalId: `${fromMe}_${chatId}_${revokedMessageId}` },
  ];
}

const PRESENCE_KINDS = new Set<string>(["online", "offline", "typing", "recording", "paused"]);

export function wahaPresenceToEvents(payload: unknown): ChannelEvent[] {
  const parsed = wahaPresenceSchema.safeParse(payload);
  if (!parsed.success) return [];
  const events: ChannelEvent[] = [];
  for (const presence of parsed.data.presences ?? []) {
    if (!presence.lastKnownPresence || !PRESENCE_KINDS.has(presence.lastKnownPresence)) continue;
    events.push({
      type: "contact.presence",
      chatId: parsed.data.id,
      participant: presence.participant ?? null,
      presence: presence.lastKnownPresence as PresenceKind,
    });
  }
  return events;
}
