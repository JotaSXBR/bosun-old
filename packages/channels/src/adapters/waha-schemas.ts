// WAHA config, webhook constants and zod payload schemas — pure data shapes,
// split from the mappers in waha-payloads.ts to keep each file small.
import { z } from "zod";

export type WahaConfig = {
  baseUrl: string;
  apiKey: string;
  session: string;
  webhookHmacKey?: string | undefined;
  /**
   * Public URL WAHA posts session events to — per-connection webhook
   * (`APP_URL` + `/api/webhooks/channels/<token>`). When set, connect()
   * (re)registers it on the session config.
   */
  webhookUrl?: string | undefined;
};

/**
 * Events subscribed on the session webhook — the full set the product
 * uses (incl. brief-2 events: reaction/edited/revoked/presence), so the
 * session config does not need re-writing when those land.
 */
export const WAHA_WEBHOOK_EVENTS = [
  "message",
  "message.ack",
  "message.reaction",
  "message.edited",
  "message.revoked",
  "session.status",
  "presence.update",
] as const;

/** WAHA retry policy — exponential 5s×8 ≈ 21min window, covers deploys. */
export const WAHA_WEBHOOK_RETRIES = {
  policy: "exponential",
  delaySeconds: 5,
  attempts: 8,
} as const;

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export const wahaSessionSchema = z.looseObject({
  name: z.string(),
  status: z.string(),
  config: z
    .looseObject({
      webhooks: z.array(z.looseObject({ url: z.string() })).optional(),
    })
    .optional(),
});

export const wahaWebhookSchema = z.looseObject({
  event: z.string(),
  session: z.string().optional(),
  timestamp: z.number().optional(),
  payload: z.unknown(),
});

export const wahaMessageSchema = z.looseObject({
  id: z.string(),
  from: z.string(),
  fromMe: z.boolean().nullish(),
  body: z.string().nullish(),
  timestamp: z.number().nullish(),
  hasMedia: z.boolean().nullish(),
  mediaUrl: z.string().nullish(),
  mimetype: z.string().nullish(),
  filename: z.string().nullish(),
  // Engines disagree on the media shape — accept both flat and nested.
  // GOWS emits explicit nulls (media/replyTo/etc.) where WEBJS omits keys.
  media: z
    .looseObject({
      url: z.string().nullish(),
      mimetype: z.string().nullish(),
      filename: z.string().nullish(),
    })
    .nullish(),
  replyTo: z
    .looseObject({
      // GOWS sends the bare stanzaID; WEBJS the full serialized id.
      id: z.string().nullish(),
      participant: z.string().nullish(),
    })
    .nullish(),
  notifyName: z.string().nullish(),
  // GOWS keeps the raw engine event here — display name lives at
  // _data.Info.PushName (WEBJS uses the top-level notifyName).
  _data: z
    .looseObject({
      // SenderAlt carries the phone of an @lid sender: "<digits>:<device>@s.whatsapp.net".
      Info: z
        .looseObject({ PushName: z.string().nullish(), SenderAlt: z.string().nullish() })
        .nullish(),
    })
    .nullish(),
});

export const wahaReactionSchema = z.looseObject({
  fromMe: z.boolean().nullish(),
  from: z.string().nullish(),
  participant: z.string().nullish(),
  // messageId is the FULL external id ("true_123@c.us_AAA"); text "" = removed.
  reaction: z.looseObject({ text: z.string().nullish(), messageId: z.string() }),
});

export const wahaEditedSchema = z.looseObject({
  // id is the edit *action* id: "false_{chatId}_{actionId}[_participant]"
  id: z.string(),
  // bare message id — no chatId, no true_/false_ prefix.
  editedMessageId: z.string(),
  body: z.string().nullish(),
});

export const wahaRevokedSchema = z.looseObject({
  // WEBJS carries the pre-revoke message in `before`; GOWS sends before:null
  // plus the bare `revokedMessageId` to compose from the action in `after`.
  before: z.looseObject({ id: z.string().nullish() }).nullish(),
  after: z.looseObject({ id: z.string().nullish(), fromMe: z.boolean().nullish() }).nullish(),
  revokedMessageId: z.string().nullish(),
});

export const wahaPresenceSchema = z.looseObject({
  id: z.string(),
  presences: z
    .array(
      z.looseObject({
        participant: z.string().optional(),
        lastKnownPresence: z.string().optional(),
      }),
    )
    .optional(),
});

export const wahaAckSchema = z.looseObject({
  id: z.string(),
  ack: z.number(),
});

export const wahaSessionStatusSchema = z.looseObject({
  status: z.string(),
});

export const wahaPairingCodeSchema = z.looseObject({
  code: z.string(),
});

/** GET /api/sessions/{s}/me — `id` is the paired jid ("5511...@c.us"). */
export const wahaMeSchema = z.looseObject({
  id: z.string().optional(),
  pushName: z.string().optional(),
  reachoutTimelock: z.unknown().optional(),
  messageCapping: z.looseObject({ state: z.string().optional() }).nullable().optional(),
});

export const wahaServerVersionSchema = z.looseObject({
  version: z.string(),
  engine: z.string().optional(),
  tier: z.string().optional(),
});

/** GET /api/{s}/chats/overview rows. */
export const wahaChatSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  lastMessage: z.looseObject({ timestamp: z.number().optional() }).nullable().optional(),
});
