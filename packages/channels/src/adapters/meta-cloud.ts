// Meta WhatsApp Cloud API adapter (graph.facebook.com).
// Send: POST /{version}/{phoneNumberId}/messages. Webhooks: signature
// `x-hub-signature-256: sha256=<hex>` (HMAC-SHA256 of the raw body with the
// App Secret); subscription handshake: GET challenge with hub.verify_token.
import { timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type {
  ChannelEvent,
  ConnectionStatus,
  ConnectResult,
  MessageContent,
  OutboundMessage,
  RawWebhookRequest,
  SendMessageResult,
} from "../domain";
import type { ChannelProvider } from "../provider";
import { verifyHmacSignature } from "../shared/hmac";
import type { FetchLike } from "./waha";

export type MetaCloudConfig = {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  graphApiVersion?: string | undefined;
};

const changeValueSchema = z.looseObject({
  messages: z.array(z.looseObject({})).optional(),
  statuses: z.array(z.looseObject({})).optional(),
});

const webhookSchema = z.looseObject({
  object: z.string().optional(),
  entry: z
    .array(
      z.looseObject({
        changes: z.array(z.looseObject({ value: changeValueSchema })).optional(),
      }),
    )
    .optional(),
});

const metaMessageSchema = z.looseObject({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional(),
  image: z
    .looseObject({
      id: z.string(),
      mime_type: z.string().optional(),
      caption: z.string().optional(),
    })
    .optional(),
  video: z
    .looseObject({
      id: z.string(),
      mime_type: z.string().optional(),
      caption: z.string().optional(),
    })
    .optional(),
  audio: z.looseObject({ id: z.string(), mime_type: z.string().optional() }).optional(),
  document: z
    .looseObject({
      id: z.string(),
      mime_type: z.string().optional(),
      caption: z.string().optional(),
      filename: z.string().optional(),
    })
    .optional(),
});

const metaStatusSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  timestamp: z.string().optional(),
});

export class MetaCloudChannelProvider implements ChannelProvider {
  readonly kind = "meta_cloud" as const;
  readonly capabilities = { qrCodeConnect: false, media: true };

  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: MetaCloudConfig,
    deps?: { fetch?: FetchLike },
  ) {
    const version = config.graphApiVersion ?? "v26.0";
    this.apiBase = `https://graph.facebook.com/${version}`;
    this.fetchImpl = deps?.fetch ?? fetch;
  }

  /** Validates credentials by fetching the phone number node. */
  async connect(): Promise<ConnectResult> {
    const res = await this.fetchImpl(`${this.apiBase}/${this.config.phoneNumberId}`, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
    });
    return { status: res.ok ? "connected" : "error" };
  }

  /** Cloud API is stateless — nothing to tear down. */
  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  async getConnectionStatus(): Promise<ConnectionStatus> {
    return (await this.connect()).status;
  }

  async sendMessage(message: OutboundMessage): Promise<SendMessageResult> {
    const body = metaSendBody(message);
    const res = await this.fetchImpl(`${this.apiBase}/${this.config.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Meta sendMessage failed: HTTP ${res.status} ${await res.text()}`);
    }
    const parsed = z
      .looseObject({ messages: z.array(z.looseObject({ id: z.string() })).optional() })
      .parse(await res.json());
    return { externalId: parsed.messages?.[0]?.id ?? "", status: "sent" };
  }

  verifyWebhook(request: RawWebhookRequest): boolean {
    const header = request.headers["x-hub-signature-256"];
    if (!header?.startsWith("sha256=")) return false;
    return verifyHmacSignature({
      algorithm: "sha256",
      secret: this.config.appSecret,
      payload: request.rawBody,
      signatureHex: header.slice("sha256=".length),
    });
  }

  /** Meta webhook subscription handshake (GET ?hub.mode&hub.verify_token&hub.challenge). */
  verificationChallenge(query: Record<string, string>): string | null {
    // Timing-safe compare: verify_token is a shared secret.
    const provided = query["hub.verify_token"];
    const expected = this.config.verifyToken;
    const tokenMatch =
      typeof provided === "string" &&
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (query["hub.mode"] === "subscribe" && tokenMatch) {
      return query["hub.challenge"] ?? null;
    }
    return null;
  }

  parseWebhook(request: RawWebhookRequest): ChannelEvent[] {
    const parsed = webhookSchema.safeParse(parseJson(request.rawBody));
    if (!parsed.success) return [];
    return (parsed.data.entry ?? []).flatMap((entry) =>
      (entry.changes ?? []).flatMap((change) => metaChangeToEvents(change.value)),
    );
  }
}

/** Malformed JSON yields undefined, which the webhook schema rejects. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function metaSendBody(message: OutboundMessage): Record<string, unknown> {
  const { content } = message;
  if (content.type === "text") {
    return {
      messaging_product: "whatsapp",
      to: message.to,
      type: "text",
      text: { body: content.text },
    };
  }
  const mediaPayload: Record<string, unknown> =
    content.source.type === "url" ? { link: content.source.url } : { id: content.source.id };
  if (content.caption) mediaPayload.caption = content.caption;
  if (content.filename && content.mediaKind === "document") {
    mediaPayload.filename = content.filename;
  }
  return {
    messaging_product: "whatsapp",
    to: message.to,
    type: content.mediaKind,
    [content.mediaKind]: mediaPayload,
  };
}

function metaChangeToEvents(value: z.infer<typeof changeValueSchema>): ChannelEvent[] {
  const events: ChannelEvent[] = [];
  for (const raw of value.messages ?? []) {
    const msg = metaMessageSchema.safeParse(raw);
    if (msg.success) events.push(metaMessageToEvent(msg.data));
  }
  for (const raw of value.statuses ?? []) {
    const event = metaStatusToEvent(raw);
    if (event) events.push(event);
  }
  return events;
}

function metaStatusToEvent(raw: unknown): ChannelEvent | null {
  const status = metaStatusSchema.safeParse(raw);
  if (!status.success) return null;
  const mapped = mapStatus(status.data.status);
  if (!mapped) return null;
  return {
    type: "message.status",
    externalMessageId: status.data.id,
    status: mapped,
    timestamp: new Date(Number(status.data.timestamp ?? 0) * 1000),
  };
}

function mapStatus(status: string): "sent" | "delivered" | "read" | "failed" | null {
  if (status === "sent" || status === "delivered" || status === "read" || status === "failed") {
    return status;
  }
  return null;
}

function metaMessageToEvent(msg: z.infer<typeof metaMessageSchema>): ChannelEvent {
  const content = metaContent(msg);
  return {
    type: "message.received",
    externalMessageId: msg.id,
    from: { channelUserId: msg.from },
    content,
    timestamp: new Date(Number(msg.timestamp) * 1000),
  };
}

type MetaMediaKind = "image" | "video" | "audio" | "document";

type MetaMediaFile = {
  id: string;
  mime_type?: string | undefined;
  caption?: string | undefined;
  filename?: string | undefined;
};

function metaContent(msg: z.infer<typeof metaMessageSchema>): MessageContent {
  if (msg.type !== "text") {
    if (msg.image) return metaMediaContent("image", msg.image);
    if (msg.video) return metaMediaContent("video", msg.video);
    if (msg.audio) return metaMediaContent("audio", msg.audio);
    if (msg.document) return metaMediaContent("document", msg.document);
  }
  return { type: "text", text: msg.text?.body ?? "" };
}

function metaMediaContent(mediaKind: MetaMediaKind, file: MetaMediaFile): MessageContent {
  return {
    type: "media",
    mediaKind,
    source: { type: "provider", id: file.id },
    ...(file.mime_type ? { mimeType: file.mime_type } : {}),
    ...(mediaKind !== "audio" && file.caption ? { caption: file.caption } : {}),
    ...(mediaKind === "document" && file.filename ? { filename: file.filename } : {}),
  };
}
