// Message-scoped repository helpers — inserts, status transitions, edits,
// revokes and reactions. Kept apart from repository.ts (contacts/tickets)
// so each file stays small.
import type { DbExecutor } from "@crm/db";
import { schema } from "@crm/db";
import { and, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";

const { messageEdits, messageReactions, messages } = schema;

export type MessageRow = typeof messages.$inferSelect;
export type MessageEditRow = typeof messageEdits.$inferSelect;
export type MessageReactionRow = typeof messageReactions.$inferSelect;

/** Loads a message by id — RLS scopes it to the caller's tenant. */
export async function getMessage(
  executor: DbExecutor,
  messageId: string,
): Promise<MessageRow | undefined> {
  const [row] = await executor.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  return row;
}

/**
 * Inserts an inbound message. The partial unique index on
 * (channel_connection_id, external_id) makes webhook replays idempotent —
 * duplicates are silently skipped and return undefined.
 */
export async function insertMessage(
  executor: DbExecutor,
  values: {
    organizationId: string;
    conversationId: string;
    channelConnectionId: string;
    contactId: string | null;
    direction: string;
    content: unknown;
    externalId: string | null;
    status: string;
    sentAt: Date | null;
    private?: boolean;
    authorId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<MessageRow | undefined> {
  const [row] = await executor
    .insert(messages)
    .values(values)
    .onConflictDoNothing({
      target: [messages.channelConnectionId, messages.externalId],
      where: sql`${messages.externalId} is not null`,
    })
    .returning();
  return row;
}

/** Shallow-merges keys into the message metadata jsonb (new keys win). */
export async function mergeMessageMetadata(
  executor: DbExecutor,
  messageId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await executor
    .update(messages)
    .set({
      metadata: sql`${messages.metadata} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(messages.id, messageId));
}

/** Marks a previously-failed outbound message as sent after a resend. */
export async function markMessageSent(
  executor: DbExecutor,
  messageId: string,
  values: { externalId: string; status: string; sentAt: Date },
): Promise<MessageRow | undefined> {
  const [row] = await executor
    .update(messages)
    .set({
      externalId: values.externalId,
      status: values.status,
      sentAt: values.sentAt,
      updatedAt: new Date(),
    })
    .where(and(eq(messages.id, messageId), eq(messages.status, "failed")))
    .returning();
  return row;
}

/** Applies a provider status (sent/delivered/read/failed) to a stored message. */
export async function updateMessageStatus(
  executor: DbExecutor,
  channelConnectionId: string,
  { externalId, status }: { externalId: string; status: string },
): Promise<MessageRow | undefined> {
  const [row] = await executor
    .update(messages)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(messages.channelConnectionId, channelConnectionId),
        eq(messages.externalId, externalId),
      ),
    )
    .returning();
  return row;
}

/**
 * Resolves a message by a set of plausible external ids — WAHA's
 * `editedMessageId` arrives without the chat/prefix, so callers pass all
 * candidates (`true_…`/`false_…`).
 */
export async function findMessageByExternalIds(
  executor: DbExecutor,
  channelConnectionId: string,
  externalIds: string[],
): Promise<MessageRow | undefined> {
  if (externalIds.length === 0) return undefined;
  const [row] = await executor
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.channelConnectionId, channelConnectionId),
        inArray(messages.externalId, externalIds),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Applies an edit: appends the previous content to `message_edits` and
 * stamps the message. The caller decides whether to record history (the
 * edit webhook echo of our own edit carries identical content → skip).
 */
export async function applyMessageEdit(
  executor: DbExecutor,
  values: {
    organizationId: string;
    messageId: string;
    previousContent: unknown;
    newContent: unknown;
    editedByUserId?: string | null;
  },
): Promise<void> {
  await executor.insert(messageEdits).values({
    organizationId: values.organizationId,
    messageId: values.messageId,
    previousContent: values.previousContent,
    editedByUserId: values.editedByUserId ?? null,
  });
  await executor
    .update(messages)
    .set({ content: values.newContent, editedAt: new Date(), updatedAt: new Date() })
    .where(eq(messages.id, values.messageId));
}

/** Stamps `revoked_at` — the original content stays (audit). */
export async function markMessageRevoked(
  executor: DbExecutor,
  channelConnectionId: string,
  externalId: string,
): Promise<MessageRow | undefined> {
  const [row] = await executor
    .update(messages)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(messages.channelConnectionId, channelConnectionId),
        eq(messages.externalId, externalId),
        sql`${messages.revokedAt} is null`,
      ),
    )
    .returning();
  return row;
}

/**
 * One reaction per actor per message — upsert on (message_id, reactor_key)
 * replaces the emoji. Empty emoji means "removed" → delete, matching
 * WhatsApp semantics.
 */
export async function upsertMessageReaction(
  executor: DbExecutor,
  values: {
    organizationId: string;
    messageId: string;
    reactorKey: string;
    emoji: string;
    actorUserId?: string | null;
    actorChannelUserId?: string | null;
    fromMe?: boolean;
  },
): Promise<void> {
  if (values.emoji === "") {
    await executor
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, values.messageId),
          eq(messageReactions.reactorKey, values.reactorKey),
        ),
      );
    return;
  }
  await executor
    .insert(messageReactions)
    .values({
      organizationId: values.organizationId,
      messageId: values.messageId,
      reactorKey: values.reactorKey,
      emoji: values.emoji,
      actorUserId: values.actorUserId ?? null,
      actorChannelUserId: values.actorChannelUserId ?? null,
      fromMe: values.fromMe ?? false,
    })
    .onConflictDoUpdate({
      target: [messageReactions.messageId, messageReactions.reactorKey],
      set: { emoji: values.emoji },
    });
}

/** Reactions for a batch of messages — the inbox render path groups them. */
export async function listReactionsForMessages(
  executor: DbExecutor,
  messageIds: string[],
): Promise<MessageReactionRow[]> {
  if (messageIds.length === 0) return [];
  return executor
    .select()
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, messageIds));
}

/** Edit history of a message — newest first for the "edições" popover. */
export async function listMessageEdits(
  executor: DbExecutor,
  messageId: string,
): Promise<MessageEditRow[]> {
  return executor
    .select()
    .from(messageEdits)
    .where(eq(messageEdits.messageId, messageId))
    .orderBy(desc(messageEdits.createdAt));
}

/**
 * Visitor-visible widget messages: internal notes and revoked rows never
 * leave the app. Cursor is the uuidv7 message id (time-ordered) — `after`
 * returns strictly newer rows. `since` scopes the listing to rows created
 * at or after the widget session — a session must never receive history
 * that predates it (the contact is claimed by email, not proven).
 */
export async function listWidgetMessages(
  executor: DbExecutor,
  conversationId: string,
  opts?: { after?: string; limit?: number; since?: Date },
): Promise<MessageRow[]> {
  return executor
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.private, false),
        isNull(messages.revokedAt),
        opts?.after ? gt(messages.id, opts.after) : undefined,
        opts?.since ? gte(messages.createdAt, opts.since) : undefined,
      ),
    )
    .orderBy(messages.id)
    .limit(opts?.limit ?? 50);
}
