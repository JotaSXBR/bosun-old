// WAHA chat actions — outbound send/seen/presence/reaction/edit/delete and
// media download. Standalone functions receiving the provider's request
// helper so waha.ts stays under the file-size limit.
import { z } from "zod";

import type { OutboundMessage, SendMessageResult } from "../domain";
import type { FetchLike } from "./waha-payloads";

type FetchResponse = Awaited<ReturnType<FetchLike>>;

/** fetch already bound to baseUrl + X-Api-Key — path or absolute URL in. */
export type WahaRequest = (
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

const JSON_HEADERS = { "Content-Type": "application/json" };

function ensureOk(res: FetchResponse, op: string): void {
  if (!res.ok) throw new Error(`WAHA ${op} failed: HTTP ${res.status}`);
}

type MediaContent = Exclude<OutboundMessage["content"], { type: "text" }>;
type SendPlan = { path: string; body: Record<string, unknown> };

function mediaPath(mediaKind: MediaContent["mediaKind"], isVoice: boolean | undefined): string {
  if (isVoice) return "/api/sendVoice";
  if (mediaKind === "image") return "/api/sendImage";
  if (mediaKind === "video") return "/api/sendVideo";
  return "/api/sendFile"; // plain audio + documents go through sendFile
}

function buildMediaPlan(session: string, to: string, content: MediaContent): SendPlan {
  if (content.source.type !== "url") {
    throw new Error("WAHA adapter only supports media by URL");
  }
  const isVoice = content.mediaKind === "audio" && content.voiceNote;
  const body: Record<string, unknown> = {
    session,
    chatId: to,
    file: {
      // Voice notes: mimetype/filename describe the target (ogg/opus
      // PTT) — convert:true transcodes the browser's webm source.
      mimetype: isVoice ? "audio/ogg; codecs=opus" : content.mimeType,
      filename: isVoice
        ? `${(content.filename ?? "voice").replace(/\.[^.]+$/, "")}.ogg`
        : content.filename,
      url: content.source.url,
    },
    caption: content.caption,
  };
  // Browser recordings (webm/opus) need transcoding to ogg/opus PTT.
  if (isVoice) body.convert = true;
  return { path: mediaPath(content.mediaKind, isVoice), body };
}

function buildSendPlan(session: string, message: OutboundMessage): SendPlan {
  const { content } = message;
  const plan: SendPlan =
    content.type === "text"
      ? { path: "/api/sendText", body: { session, chatId: message.to, text: content.text } }
      : buildMediaPlan(session, message.to, content);
  if (message.replyToId) plan.body.reply_to = message.replyToId;
  return plan;
}

export async function wahaSendMessage(
  request: WahaRequest,
  session: string,
  message: OutboundMessage,
): Promise<SendMessageResult> {
  const { path, body } = buildSendPlan(session, message);
  const res = await request(path, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`WAHA sendMessage failed: HTTP ${res.status} ${await res.text()}`);
  }
  const parsed = z.looseObject({ id: z.string().optional() }).parse(await res.json());
  return { externalId: parsed.id ?? "", status: "sent" };
}

/** Marks the whole chat read — remote sees blue ticks. */
export async function wahaSendSeen(
  request: WahaRequest,
  session: string,
  chatId: string,
): Promise<void> {
  const res = await request("/api/sendSeen", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ session, chatId }),
  });
  ensureOk(res, "sendSeen");
}

/** typing/recording expire ~10s on the remote; paused clears early. */
export async function wahaSendPresence(
  request: WahaRequest,
  session: string,
  { chatId, presence }: { chatId: string; presence: "typing" | "recording" | "paused" },
): Promise<void> {
  const res = await request(`/api/${session}/presence`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ chatId, presence }),
  });
  ensureOk(res, "sendPresence");
}

/** Subscribe to the contact's presence (drives presence.update webhooks). */
export async function wahaSubscribePresence(
  request: WahaRequest,
  session: string,
  chatId: string,
): Promise<void> {
  const res = await request(`/api/${session}/presence/${encodeURIComponent(chatId)}/subscribe`, {
    method: "POST",
  });
  if (!res.ok && res.status !== 404) ensureOk(res, "subscribePresence");
}

/** Empty emoji removes the actor's reaction (WAHA reaction endpoint). */
export async function wahaSendReaction(
  request: WahaRequest,
  session: string,
  { messageExternalId, emoji }: { messageExternalId: string; emoji: string },
): Promise<void> {
  const res = await request("/api/reaction", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ session, messageId: messageExternalId, reaction: emoji }),
  });
  ensureOk(res, "sendReaction");
}

/** A chat message targeted for edit/delete. */
export type WahaMessageTarget = { chatId: string; messageExternalId: string };

const chatMessagePath = (session: string, target: WahaMessageTarget) =>
  `/api/${session}/chats/${encodeURIComponent(target.chatId)}/messages/${encodeURIComponent(target.messageExternalId)}`;

export async function wahaEditMessage(
  request: WahaRequest,
  session: string,
  edit: WahaMessageTarget & { text: string },
): Promise<void> {
  const res = await request(chatMessagePath(session, edit), {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ text: edit.text }),
  });
  ensureOk(res, "editMessage");
}

/** Revokes the message "for everyone" — remote shows the deleted placeholder. */
export async function wahaDeleteMessage(
  request: WahaRequest,
  session: string,
  target: WahaMessageTarget,
): Promise<void> {
  const res = await request(chatMessagePath(session, target), { method: "DELETE" });
  ensureOk(res, "deleteMessage");
}

/**
 * What the by-id download endpoint says about the message's media. `url`
 * is the preferred fetch target but is unreliable on GOWS (may be null,
 * the raw WhatsApp CDN .enc, or an S3 pre-signed url); `filename` is the
 * name of the file WAHA saved — local storage keeps it at
 * /api/files/{session}/{name}; `error` carries WAHA's own download
 * failure detail for diagnostics.
 */
export type WahaMessageMediaRef = {
  url: string | null;
  filename: string | null;
  mimetype: string | null;
  s3: { bucket: string; key: string } | null;
  error: string | null;
};

/**
 * On-demand media download: WAHA re-downloads the message's media from
 * WhatsApp and answers with the message payload. Returns null when the
 * message has no media — the caller fetches the url/filename through the
 * same-origin guard afterwards.
 */
export async function wahaFetchMessageMediaRef(
  request: WahaRequest,
  session: string,
  target: WahaMessageTarget,
): Promise<WahaMessageMediaRef | null> {
  const res = await request(`${chatMessagePath(session, target)}?downloadMedia=true`);
  ensureOk(res, "fetchMessageMedia");
  const parsed = z
    .looseObject({
      media: z
        .looseObject({
          url: z.string().nullish(),
          filename: z.string().nullish(),
          mimetype: z.string().nullish(),
          s3: z.looseObject({ Bucket: z.string(), Key: z.string() }).nullish(),
          error: z
            .looseObject({ code: z.number().nullish(), details: z.string().nullish() })
            .nullish(),
        })
        .nullish(),
      mediaUrl: z.string().nullish(),
    })
    .parse(await res.json());
  if (!parsed.media && !parsed.mediaUrl) return null;
  const mediaError = parsed.media?.error;
  return {
    url: parsed.media?.url ?? parsed.mediaUrl ?? null,
    filename: parsed.media?.filename ?? null,
    mimetype: parsed.media?.mimetype ?? null,
    s3: parsed.media?.s3 ? { bucket: parsed.media.s3.Bucket, key: parsed.media.s3.Key } : null,
    error: mediaError ? `code ${mediaError.code ?? "?"}: ${mediaError.details ?? ""}` : null,
  };
}

/** Inbound media lives on the WAHA host — fetch with the api key and stream. */
export async function wahaFetchMedia(
  request: WahaRequest,
  url: string,
): Promise<{ body: Uint8Array; contentType: string | null }> {
  const res = await request(url);
  ensureOk(res, "fetchMedia");
  return {
    body: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get("content-type"),
  };
}
