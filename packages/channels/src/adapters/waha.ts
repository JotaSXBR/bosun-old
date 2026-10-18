// WAHA (WhatsApp HTTP API, devlikeapro/waha) adapter — lifecycle + webhooks
// here; outbound chat actions in waha-actions.ts, payloads in
// waha-payloads.ts. Auth: X-Api-Key; webhook HMAC (sha512) is mandatory.
import { z } from "zod";

import type {
  ChannelEvent,
  ConnectionStatus,
  ConnectResult,
  ExternalChat,
  InboundChannelMessage,
  OutboundMessage,
  RawWebhookRequest,
  SendMessageResult,
  ServerInfo,
  SessionInfo,
} from "../domain";
import type { ChannelProvider } from "../provider";
import { verifyHmacSignature } from "../shared/hmac";
import type { WahaRequest } from "./waha-actions";
import {
  wahaDeleteMessage,
  wahaEditMessage,
  wahaFetchMedia,
  wahaFetchMessageMediaRef,
  wahaSendMessage,
  wahaSendPresence,
  wahaSendReaction,
  wahaSendSeen,
  wahaSubscribePresence,
} from "./waha-actions";
import { isAnonymousFetchable, mediaFilePaths, resolveMediaUrl } from "./waha-media";
import type { FetchLike, WahaConfig } from "./waha-payloads";
import {
  wahaAckToEvents,
  wahaChatSchema,
  wahaEditedToEvents,
  wahaMessageSchema,
  wahaMessageToEvents,
  wahaPresenceToEvents,
  wahaReactionToEvents,
  wahaRevokedToEvents,
  wahaSessionStatusToEvents,
  wahaToInbound,
  wahaWebhookSchema,
} from "./waha-payloads";
import {
  type SessionCtx,
  wahaConnect,
  wahaGetConnectionStatus,
  wahaGetServerInfo,
  wahaGetSessionInfo,
  wahaRequestPairingCode,
  wahaSessionCommand,
} from "./waha-session";

export type { FetchLike, WahaConfig } from "./waha-payloads";
export { WAHA_WEBHOOK_EVENTS, WAHA_WEBHOOK_RETRIES } from "./waha-payloads";

export class WahaChannelProvider implements ChannelProvider {
  readonly kind = "waha" as const;
  readonly capabilities = { qrCodeConnect: true, media: true };

  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: WahaConfig,
    deps?: { fetch?: FetchLike },
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = deps?.fetch ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { "X-Api-Key": this.config.apiKey, ...extra };
  }

  private get session(): SessionCtx {
    return { config: this.config, request: this.request };
  }

  connect(): Promise<ConnectResult> {
    return wahaConnect(this.session);
  }

  disconnect(): Promise<void> {
    return wahaSessionCommand(this.session, "stop");
  }

  restart(): Promise<void> {
    return wahaSessionCommand(this.session, "restart");
  }

  /** Unpairs the device — next connect() will need QR/pairing code again. */
  logout(): Promise<void> {
    return wahaSessionCommand(this.session, "logout");
  }

  /** WhatsApp "connect with phone number" — the code the user types in the app. */
  requestPairingCode(phoneNumber: string): Promise<{ code: string }> {
    return wahaRequestPairingCode(this.session, phoneNumber);
  }

  getSessionInfo(): Promise<SessionInfo> {
    return wahaGetSessionInfo(this.session);
  }

  getServerInfo(): Promise<ServerInfo> {
    return wahaGetServerInfo(this.session);
  }

  /** 1:1 chats only — groups (@g.us), broadcasts and newsletters are skipped. */
  async listChats(opts?: { limit?: number; offset?: number }): Promise<ExternalChat[]> {
    const params = new URLSearchParams({
      limit: String(opts?.limit ?? 100),
      offset: String(opts?.offset ?? 0),
    });
    const res = await this.request(
      `/api/${this.config.session}/chats/overview?${params.toString()}`,
    );
    if (!res.ok) {
      throw new Error(`WAHA list chats failed: HTTP ${res.status}`);
    }
    const chats = z.array(wahaChatSchema).parse(await res.json());
    return chats
      .filter(
        (chat) =>
          !chat.id.endsWith("@g.us") &&
          !chat.id.endsWith("@broadcast") &&
          !chat.id.endsWith("@newsletter"),
      )
      .map((chat) => ({
        id: chat.id,
        ...(chat.name ? { name: chat.name } : {}),
        ...(chat.lastMessage?.timestamp
          ? { lastMessageAt: new Date(chat.lastMessage.timestamp * 1000) }
          : {}),
      }));
  }

  /** Backfill source — same message mapping as live webhooks. */
  async listMessages(
    chatId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<InboundChannelMessage[]> {
    const params = new URLSearchParams({
      chatId,
      limit: String(opts?.limit ?? 100),
      offset: String(opts?.offset ?? 0),
      session: this.config.session,
    });
    const res = await this.request(`/api/messages?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`WAHA list messages failed: HTTP ${res.status}`);
    }
    const rows = z.array(z.unknown()).parse(await res.json());
    return rows.flatMap((row) => {
      const message = wahaMessageSchema.safeParse(row);
      return message.success && !message.data.fromMe ? [wahaToInbound(message.data)] : [];
    });
  }

  getConnectionStatus(): Promise<ConnectionStatus> {
    return wahaGetConnectionStatus(this.session);
  }

  /** fetch bound to baseUrl + X-Api-Key; absolute media URLs pass through. */
  private readonly request: WahaRequest = (path, init) =>
    this.fetchImpl(path.startsWith("http") ? path : `${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init?.headers),
    });

  sendMessage(message: OutboundMessage): Promise<SendMessageResult> {
    return wahaSendMessage(this.request, this.config.session, message);
  }

  sendSeen(chatId: string): Promise<void> {
    return wahaSendSeen(this.request, this.config.session, chatId);
  }

  sendPresence(chatId: string, presence: "typing" | "recording" | "paused"): Promise<void> {
    return wahaSendPresence(this.request, this.config.session, { chatId, presence });
  }

  subscribePresence(chatId: string): Promise<void> {
    return wahaSubscribePresence(this.request, this.config.session, chatId);
  }

  sendReaction(messageExternalId: string, emoji: string): Promise<void> {
    return wahaSendReaction(this.request, this.config.session, { messageExternalId, emoji });
  }

  editMessage(chatId: string, messageExternalId: string, text: string): Promise<void> {
    return wahaEditMessage(this.request, this.config.session, { chatId, messageExternalId, text });
  }

  deleteMessage(chatId: string, messageExternalId: string): Promise<void> {
    return wahaDeleteMessage(this.request, this.config.session, { chatId, messageExternalId });
  }

  /** See resolveMediaUrl (waha-media.ts) — the api key never leaves the WAHA host. */
  private resolveMediaUrl(url: string): string {
    return resolveMediaUrl(this.baseUrl, url);
  }

  async fetchMedia(url: string): Promise<{ body: Uint8Array; contentType: string | null }> {
    return wahaFetchMedia(this.request, this.resolveMediaUrl(url));
  }

  /**
   * Fallback for inbound media whose stored url isn't fetchable — sticker
   * payloads carry the WhatsApp CDN .enc blob, not a local path. Asks WAHA
   * to download the message's media on demand, then tries what the
   * response offers, in order:
   *  1. media.url through the origin guard (local /api/files/* paths and
   *     same-origin urls pass; foreign /api/files/* re-roots onto baseUrl)
   *  2. media.url anonymous — WAHA_MEDIA_STORAGE=s3 with S3 proxy off
   *     stamps a pre-signed http(s) url, fetchable without the api key
   *  3. /api/files/{session}/{filename|messageId.ext} — MediaLocalStorage
   *     keeps files under a per-session directory
   * The WhatsApp CDN (*.whatsapp.net .enc blobs) is never fetched — the
   * bytes are encrypted and useless anyway.
   */
  async fetchMessageMedia(
    chatId: string,
    messageId: string,
  ): Promise<{ body: Uint8Array; contentType: string | null } | null> {
    const ref = await wahaFetchMessageMediaRef(this.request, this.config.session, {
      chatId,
      messageExternalId: messageId,
    });
    if (!ref) return null;
    let lastError: unknown;
    for (const attempt of this.mediaAttempts(ref, messageId)) {
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
      }
    }
    const detail = lastError instanceof Error ? ` — last: ${lastError.message}` : "";
    throw new Error(
      `WAHA fetchMessageMedia: no downloadable media${ref.error ? ` (${ref.error})` : ""}${detail}`,
    );
  }

  /** Download attempts for a message's media, in the order documented on fetchMessageMedia. */
  private mediaAttempts(
    ref: NonNullable<Awaited<ReturnType<typeof wahaFetchMessageMediaRef>>>,
    messageId: string,
  ): Array<() => Promise<{ body: Uint8Array; contentType: string | null }>> {
    const fetchPath = (path: string) => () =>
      wahaFetchMedia(this.request, this.resolveMediaUrl(path));
    const { url, s3 } = ref;
    return [
      ...(url
        ? [
            fetchPath(url),
            ...(isAnonymousFetchable(url) ? [() => this.fetchAnonymousMedia(url)] : []),
          ]
        : []),
      // S3 storage stamps the exact object location — the proxy route is
      // /api/s3/{bucket}/{key} (WAHA_S3_PROXY_FILES). Works even when
      // media.url is null or stamped with WAHA's localhost base.
      ...(s3 ? [fetchPath(`/api/s3/${s3.bucket}/${s3.key}`)] : []),
      ...mediaFilePaths(this.config.session, {
        filename: ref.filename,
        messageId,
        mimetype: ref.mimetype,
      }).map(fetchPath),
    ];
  }

  private async fetchAnonymousMedia(
    url: string,
  ): Promise<{ body: Uint8Array; contentType: string | null }> {
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`WAHA fetchMedia failed: HTTP ${res.status}`);
    return {
      body: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type"),
    };
  }

  /**
   * Two hops: WAHA resolves the WhatsApp CDN URL, then a plain anonymous
   * fetch downloads it. `request` would attach X-Api-Key — the key must
   * never leave the WAHA host, so the second hop uses raw fetch.
   */
  async fetchContactAvatar(
    channelUserId: string,
  ): Promise<{ body: Uint8Array; contentType: string | null } | null> {
    const res = await this.request(
      `/api/contacts/profile-picture?session=${encodeURIComponent(this.config.session)}&contactId=${encodeURIComponent(channelUserId)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`WAHA profile-picture failed: HTTP ${res.status}`);
    const parsed = z
      .looseObject({ profilePictureURL: z.string().nullish() })
      .parse(await res.json());
    const url = parsed.profilePictureURL;
    if (!url?.startsWith("https://")) return null;
    const img = await this.fetchImpl(url);
    if (!img.ok) return null;
    return {
      body: new Uint8Array(await img.arrayBuffer()),
      contentType: img.headers.get("content-type"),
    };
  }

  verifyWebhook(request: RawWebhookRequest): boolean {
    // HMAC is mandatory for us — never trust an unsigned webhook.
    const key = this.config.webhookHmacKey;
    if (!key) return false;
    const signature = request.headers["x-webhook-hmac"];
    if (!signature) return false;
    const algorithm = request.headers["x-webhook-hmac-algorithm"] ?? "sha512";
    if (algorithm !== "sha512") return false;
    return verifyHmacSignature({
      algorithm: "sha512",
      secret: key,
      payload: request.rawBody,
      signatureHex: signature,
    });
  }

  parseWebhook(request: RawWebhookRequest): ChannelEvent[] {
    let raw: unknown;
    try {
      raw = JSON.parse(request.rawBody);
    } catch {
      return [];
    }
    const parsed = wahaWebhookSchema.safeParse(raw);
    if (!parsed.success) return [];
    const { event, timestamp, payload } = parsed.data;

    switch (event) {
      case "message":
        return wahaMessageToEvents(payload, timestamp);
      case "message.ack":
        return wahaAckToEvents(payload, timestamp);
      case "message.reaction":
        return wahaReactionToEvents(payload);
      case "message.edited":
        return wahaEditedToEvents(payload);
      case "message.revoked":
        return wahaRevokedToEvents(payload);
      case "presence.update":
        return wahaPresenceToEvents(payload);
      case "session.status":
        return wahaSessionStatusToEvents(payload);
      default:
        return [];
    }
  }
}
