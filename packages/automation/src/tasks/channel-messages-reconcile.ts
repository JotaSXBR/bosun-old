import type { ChannelProvider } from "@crm/channels";
import type { ChannelConnectionRow } from "@crm/core/integrations";
import { listConnectionsForReconcile, resolveConnectionProvider } from "@crm/core/integrations";
import type { ConnectionRef } from "@crm/core/messaging";
import { ingestChannelEvent } from "@crm/core/messaging";
import type { Database } from "@crm/db";
import { getDb, withTenant } from "@crm/db";
import { createLogger } from "@crm/observability";
import { z } from "zod";

const logger = createLogger({ bindings: { component: "jobs" } });

/**
 * Targeted run (after connect / manual re-sync) carries the connection
 * identity; the scheduled sweep sends an empty payload and reconciles every
 * live WAHA session.
 */
export const channelReconcilePayload = z.object({
  organizationId: z.uuid().optional(),
  channelConnectionId: z.uuid().optional(),
});

export type ChannelReconcilePayload = z.infer<typeof channelReconcilePayload>;

const CHAT_PAGE = 100;
const MESSAGE_PAGE = 100;
/** Backfill safety bound per chat per run — dedup makes re-runs cheap. */
const MAX_MESSAGES_PER_CHAT = 500;

type Totals = { listed: number; ingested: number };
type BackfillContext = { db: Database; conn: ConnectionRef; provider: ChannelProvider };
type ChatMessages = Awaited<ReturnType<NonNullable<ChannelProvider["listMessages"]>>>;

/** Backfilling a dead session would query a stopped WAHA session — skip until it reconnects. */
async function deadSessionReason(provider: ChannelProvider): Promise<string | undefined> {
  const session = await provider.getSessionInfo?.().catch(() => undefined);
  return session && session.status !== "connected" ? `session-${session.status}` : undefined;
}

async function reconcileConnection(
  db: Database,
  connection: ChannelConnectionRow,
): Promise<Totals & { skipped?: string }> {
  const provider = (await resolveConnectionProvider(db, connection.organizationId, connection.id))
    ?.provider;
  if (!provider?.listChats || !provider.listMessages) {
    return { listed: 0, ingested: 0, skipped: "provider-unsupported" };
  }
  const skipped = await deadSessionReason(provider);
  if (skipped) return { listed: 0, ingested: 0, skipped };

  const conn: ConnectionRef = {
    id: connection.id,
    organizationId: connection.organizationId,
    kind: connection.kind,
  };
  return backfillChats({ db, conn, provider }, await provider.listChats({ limit: CHAT_PAGE }));
}

async function backfillChats(ctx: BackfillContext, chats: { id: string }[]): Promise<Totals> {
  const total: Totals = { listed: 0, ingested: 0 };
  for (const chat of chats) {
    const result = await backfillChat(ctx, chat.id);
    total.listed += result.listed;
    total.ingested += result.ingested;
  }
  return total;
}

/** Pages one chat's history into the ingest path (deduped, no fan-out). */
async function backfillChat(ctx: BackfillContext, chatId: string): Promise<Totals> {
  const total: Totals = { listed: 0, ingested: 0 };
  for (let offset = 0; offset < MAX_MESSAGES_PER_CHAT; offset += MESSAGE_PAGE) {
    const messages = await ctx.provider.listMessages?.(chatId, { limit: MESSAGE_PAGE, offset });
    if (!messages?.length) break;
    total.listed += messages.length;
    total.ingested += await ingestMessages(ctx, messages);
    if (messages.length < MESSAGE_PAGE) break;
  }
  return total;
}

async function ingestMessages(ctx: BackfillContext, messages: ChatMessages): Promise<number> {
  let ingested = 0;
  for (const message of messages) {
    // No enqueue dep on purpose: deduped ingest only. Enqueueing
    // process-channel-event here would fire off-hours auto-replies for
    // messages received while the stack was down.
    const result = await withTenant(ctx.db, ctx.conn.organizationId, (tx) =>
      ingestChannelEvent(tx, ctx.conn, { type: "message.received", ...message }),
    );
    if (result.messageId) ingested += 1;
  }
  return ingested;
}

/**
 * Targeted runs resolve the row directly (a stale `status` is fine — the
 * session check inside reconcileConnection skips dead sessions); the
 * sweep only picks connections persisted as connected.
 */
async function connectionsToReconcile(
  db: Database,
  parsed: ChannelReconcilePayload,
): Promise<ChannelConnectionRow[]> {
  if (!parsed.organizationId || !parsed.channelConnectionId) {
    return listConnectionsForReconcile(db);
  }
  const resolved = await resolveConnectionProvider(
    db,
    parsed.organizationId,
    parsed.channelConnectionId,
  );
  return resolved ? [resolved.connection] : [];
}

/**
 * Recovers messages WAHA received while Bosun (or WAHA itself) was down —
 * history-sync delivery for those is engine-dependent, so this polls
 * `listChats`/`listMessages` and ingests through the same dedup path as the
 * webhook (`channelConnectionId + externalId` unique). Idempotent.
 */
export async function channelReconcileHandler(
  payload: unknown,
): Promise<{ connections: number } & Totals> {
  const parsed = channelReconcilePayload.parse(payload);
  const db = getDb();
  const connections = await connectionsToReconcile(db, parsed);
  const total: Totals = { listed: 0, ingested: 0 };
  for (const connection of connections) {
    const result = await reconcileConnection(db, connection).catch((error: unknown) => {
      logger.error("channel reconcile failed", {
        channelConnectionId: connection.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { listed: 0, ingested: 0 };
    });
    total.listed += result.listed;
    total.ingested += result.ingested;
  }
  return { connections: connections.length, ...total };
}
