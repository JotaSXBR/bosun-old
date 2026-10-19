// Unsupported-media auto-reply — once per ticket, when an inbound media
// lands without a fetchable source (metadata.unsupportedMedia set at
// ingest). The org-authored template lives in
// organization_settings.unsupported_media_message — unset/empty disables
// the reply entirely (the bubble's internal note always shows either
// way). Mirrors the off-hours flow: the marker row is reserved inside
// the tenant tx BEFORE the provider call so concurrent jobs can't
// double-send (partial unique index messages_unsupported_media_idx); a
// provider failure marks it `failed` and rethrows for pg-boss retry.
import type { ChannelProvider } from "@crm/channels";
import { providerForConnection } from "@crm/core/integrations";
import type { Database, DbExecutor } from "@crm/db";
import { emitDomainEvent, schema, sql, withTenant } from "@crm/db";

import { findSettings } from "../organizations";
import { sendWithEnvelope } from "./outbound";
import type { ConversationRow, MessageRow } from "./repository";
import { getConversation, updateConversationLastMessage } from "./repository";
import { getMessage } from "./repository-messages";

const { messages } = schema;

const SYSTEM_MARKER = "unsupported_media";

export type UnsupportedMediaResult =
  { sent: true; messageId: string } | { sent: false; reason: string };

type ReplyPlan =
  | { ok: true; organizationId: string; conv: ConversationRow; text: string; now: Date }
  | { ok: false; reason: string };

function isUnsupportedInbound(
  message: Awaited<ReturnType<typeof getMessage>>,
  conv: ConversationRow,
): boolean {
  const meta = message?.metadata as { unsupportedMedia?: boolean } | undefined;
  return (
    message?.conversationId === conv.id &&
    message.direction === "inbound" &&
    meta?.unsupportedMedia === true
  );
}

/** Loads conv + settings + the ingested message and applies every gate. */
async function planReply(
  db: Database,
  opts: { organizationId: string; conversationId: string; messageId: string; now?: Date },
): Promise<ReplyPlan> {
  const now = opts.now ?? new Date();
  const [conv, settings, message] = await withTenant(db, opts.organizationId, async (tx) =>
    Promise.all([
      getConversation(tx, opts.conversationId),
      findSettings(tx, opts.organizationId),
      getMessage(tx, opts.messageId),
    ]),
  );
  if (!conv || ["resolved", "closed"].includes(conv.status)) {
    return { ok: false, reason: "no-active-ticket" };
  }
  const template = settings?.unsupportedMediaMessage?.trim();
  if (!template) return { ok: false, reason: "not-configured" };
  if (!isUnsupportedInbound(message, conv)) return { ok: false, reason: "not-unsupported" };
  return { ok: true, organizationId: opts.organizationId, conv, text: template, now };
}

/**
 * Reserves the per-ticket marker row. The partial unique index
 * (conversation_id where metadata->>'system' = marker) makes concurrent
 * jobs conflict — one wins, the other gets undefined and skips. Returns
 * the marker row, or the existing failed row to retry, or undefined.
 */
async function reserveMarker(
  executor: DbExecutor,
  conv: ConversationRow,
  text: string,
): Promise<MessageRow | undefined> {
  const [existing] = await executor
    .select()
    .from(messages)
    .where(
      sql`${messages.conversationId} = ${conv.id}
          and ${messages.metadata} ->> 'system' = ${SYSTEM_MARKER}`,
    )
    .limit(1);
  if (existing) {
    // Failed attempt — the job is retrying: reuse the row.
    return existing.status === "failed" ? existing : undefined;
  }
  const [row] = await executor
    .insert(messages)
    .values({
      organizationId: conv.organizationId,
      conversationId: conv.id,
      channelConnectionId: conv.channelConnectionId,
      contactId: conv.contactId,
      direction: "outbound",
      content: { type: "text", text },
      externalId: null,
      status: "queued",
      sentAt: new Date(),
      authorId: null,
      metadata: { system: SYSTEM_MARKER },
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

/** Provider send (outside any tx) + marker update + fan-out event. */
async function deliverReply(
  db: Database,
  plan: Extract<ReplyPlan, { ok: true }>,
  { marker, deps }: { marker: MessageRow; deps?: { provider?: ChannelProvider } },
): Promise<UnsupportedMediaResult> {
  const provider =
    deps?.provider ??
    (await providerForConnection(db, plan.organizationId, plan.conv.channelConnectionId));
  let sent: { externalId: string; status: string };
  try {
    // Automated reply → full anti-ban envelope (seen → typing → paused → send).
    sent = await sendWithEnvelope(provider, plan.conv.externalId, plan.text);
  } catch (cause) {
    await withTenant(db, plan.organizationId, (tx) =>
      tx
        .update(messages)
        .set({ status: "failed", updatedAt: new Date() })
        .where(sql`${messages.id} = ${marker.id}`),
    );
    throw cause;
  }
  await withTenant(db, plan.organizationId, async (tx) => {
    await tx
      .update(messages)
      .set({
        externalId: sent.externalId,
        status: sent.status,
        // A retry may have sent a newer template than the first attempt —
        // the marker row mirrors what actually went out.
        content: { type: "text", text: plan.text },
        updatedAt: new Date(),
      })
      .where(sql`${messages.id} = ${marker.id}`);
    await updateConversationLastMessage(tx, plan.conv.id, {
      lastMessageAt: plan.now,
      lastMessage: {
        direction: "outbound",
        preview: plan.text,
      },
    });
    await emitDomainEvent(tx, {
      type: "message.sent",
      organizationId: plan.organizationId,
      conversationId: plan.conv.id,
      messageId: marker.id,
      authorId: null,
      sentAt: plan.now.toISOString(),
    });
  });
  return { sent: true, messageId: marker.id };
}

/**
 * Sends the unsupported-media reply for a freshly ingested inbound, when
 * the org configured a template and this ticket never got one. System
 * send: no agent semantics — authorId null, ticket untouched.
 */
export async function maybeSendUnsupportedMediaReply(
  db: Database,
  opts: { organizationId: string; conversationId: string; messageId: string; now?: Date },
  deps?: { provider?: ChannelProvider },
): Promise<UnsupportedMediaResult> {
  const plan = await planReply(db, opts);
  if (!plan.ok) return { sent: false, reason: plan.reason };
  const marker = await withTenant(db, opts.organizationId, (tx) =>
    reserveMarker(tx, plan.conv, plan.text),
  );
  if (!marker) return { sent: false, reason: "already-sent" };
  return deliverReply(db, plan, { marker, deps });
}
