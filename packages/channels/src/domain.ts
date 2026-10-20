// Domain model for messaging channels — provider-agnostic by design.
// Nothing here references WAHA or Meta payload shapes.

export type ChannelProviderKind = "waha" | "meta_cloud" | "site_chat";

export type MessageContent =
  | { type: "text"; text: string; quotedExternalId?: string }
  | {
      type: "media";
      mediaKind: "image" | "video" | "audio" | "document";
      source: { type: "url"; url: string } | { type: "provider"; id: string };
      mimeType?: string;
      caption?: string;
      filename?: string;
      /** Voice note → provider sends it as a PTT bubble (WAHA sendVoice). */
      voiceNote?: boolean;
      quotedExternalId?: string;
      /**
       * Object-storage key of an outbound upload — persisted so the media
       * proxy can re-serve it after the signed source.url expires.
       */
      storageKey?: string;
    };

export type Participant = {
  channelUserId: string;
  /** Opaque WhatsApp `@lid` id when `channelUserId` was resolved to the phone. */
  lid?: string;
  displayName?: string;
};

export type OutboundMessage = {
  /** Recipient id in channel terms (WhatsApp chatId / phone number). */
  to: string;
  content: MessageContent;
  /** External id of the message this replies to (quoted bubble). */
  replyToId?: string;
};

export type SendMessageResult = {
  externalId: string;
  status: "sent" | "queued";
};

export type ConnectionStatus = "connected" | "connecting" | "disconnected" | "error";

export type ConnectResult = {
  status: ConnectionStatus;
  /** QR to display while pairing (WAHA). */
  qrCode?: { mimeType: string; data: string };
};

/** Live session details beyond the coarse status (WAHA /me + session). */
export type SessionInfo = {
  status: ConnectionStatus;
  /** Paired phone number without the "@c.us" suffix (WAHA /me). */
  phone?: string;
  /** WhatsApp display name of the paired account. */
  pushName?: string;
  /** Active restriction warnings (e.g. "reachout_timelock", "message_capping"). */
  warnings: string[];
};

/** WAHA server build info (GET /api/server/version). */
export type ServerInfo = {
  version: string;
  engine: string;
  tier?: string;
};

/** A chat as the provider lists it (WAHA chats/overview). */
export type ExternalChat = {
  id: string;
  name?: string;
  lastMessageAt?: Date;
};

/** One inbound message — shared by live webhooks and backfill listing. */
export type InboundChannelMessage = {
  externalMessageId: string;
  from: Participant;
  content: MessageContent;
  timestamp: Date;
};

/** Chat presence values mapped onto the WhatsApp UX (GOWS lastKnownPresence). */
export type PresenceKind = "online" | "offline" | "typing" | "recording" | "paused";

export type ChannelEvent =
  | ({ type: "message.received" } & InboundChannelMessage)
  | {
      type: "message.status";
      externalMessageId: string;
      status: "sent" | "delivered" | "read" | "failed";
      timestamp: Date;
    }
  | {
      type: "message.reaction";
      /** External id of the reacted-to message (WAHA full id). */
      messageExternalId: string;
      /** Emoji — empty string means the actor removed their reaction. */
      emoji: string;
      actorChannelUserId: string | null;
      fromMe: boolean;
    }
  | {
      type: "message.edited";
      /**
       * Candidate external ids — WAHA's `editedMessageId` lacks the
       * true_/false_ prefix and chatId, so all plausible ids are emitted
       * and the consumer resolves which row exists.
       */
      messageExternalIds: string[];
      newText: string;
    }
  | { type: "message.revoked"; messageExternalId: string }
  | {
      type: "contact.presence";
      chatId: string;
      participant: string | null;
      presence: PresenceKind;
    }
  | { type: "connection.status"; status: ConnectionStatus };

/**
 * A webhook HTTP request after the transport layer stripped it down.
 * `rawBody` must be the exact bytes received (needed for HMAC), header names
 * are lowercased.
 */
export type RawWebhookRequest = {
  rawBody: string;
  headers: Record<string, string>;
  query: Record<string, string>;
};
