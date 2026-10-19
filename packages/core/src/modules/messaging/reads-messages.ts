import type { Database, DbExecutor } from "@crm/db";
import { schema, withTenant } from "@crm/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { MessageRow } from "./repository";

const { messageReactions, messages, users } = schema;

/** One stored reaction — reactorKey is the channel id or the user uuid. */
export type MessageReactionView = {
  emoji: string;
  reactorKey: string;
  fromMe: boolean;
  actorUserId: string | null;
};

/** Resolved quote target (content.quotedExternalId → stored message). */
export type QuotedMessageView = {
  preview: string | null;
  direction: string;
  authorName: string | null;
  revoked: boolean;
};

/** Message row plus author name, reactions and the resolved quote target. */
export type MessageWithAuthorRow = MessageRow & {
  authorName: string | null;
  reactions: MessageReactionView[];
  quoted: QuotedMessageView | null;
};

/** Pre-enrichment row — message plus joined author name. */
type FetchedMessageRow = MessageRow & { authorName: string | null };

const MESSAGE_PREVIEW_SQL = sql<
  string | null
>`coalesce(${messages.content} ->> 'text', ${messages.content} ->> 'caption', '[' || (${messages.content} ->> 'type') || ']')`;

/** externalId this message quotes — set on text and media contents. */
function quotedExternalIdOf(content: unknown): string | null {
  if (typeof content !== "object" || content === null) return null;
  const quoted = (content as Record<string, unknown>).quotedExternalId;
  return typeof quoted === "string" && quoted.length > 0 ? quoted : null;
}

async function fetchReactions(executor: DbExecutor, ids: string[]) {
  if (ids.length === 0) return [];
  return executor
    .select()
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, ids))
    .orderBy(asc(messageReactions.createdAt));
}

async function fetchQuoted(
  executor: DbExecutor,
  { conversationId, quotedIds }: { conversationId: string; quotedIds: string[] },
) {
  if (quotedIds.length === 0) return [];
  return executor
    .select({
      externalId: messages.externalId,
      preview: MESSAGE_PREVIEW_SQL,
      direction: messages.direction,
      authorName: users.name,
      revokedAt: messages.revokedAt,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(
      and(eq(messages.conversationId, conversationId), inArray(messages.externalId, quotedIds)),
    );
}

function groupReactions(rows: Awaited<ReturnType<typeof fetchReactions>>) {
  const byMessage = new Map<string, MessageReactionView[]>();
  for (const r of rows) {
    const bucket = byMessage.get(r.messageId) ?? [];
    bucket.push({
      emoji: r.emoji,
      reactorKey: r.reactorKey,
      fromMe: r.fromMe,
      actorUserId: r.actorUserId,
    });
    byMessage.set(r.messageId, bucket);
  }
  return byMessage;
}

function indexQuoted(rows: Awaited<ReturnType<typeof fetchQuoted>>) {
  return new Map(
    rows
      .filter((r) => r.externalId !== null)
      .map((r) => [
        r.externalId!,
        {
          preview: r.preview,
          direction: r.direction,
          authorName: r.authorName,
          revoked: r.revokedAt !== null,
        },
      ]),
  );
}

/** Reactions + quote resolution for a fetched window of message rows. */
async function enrichMessages(
  executor: DbExecutor,
  conversationId: string,
  list: FetchedMessageRow[],
): Promise<MessageWithAuthorRow[]> {
  const ids = list.map((m) => m.id);
  const quotedIds = [
    ...new Set(list.map((m) => quotedExternalIdOf(m.content)).filter((v) => v !== null)),
  ];
  const [reactionRows, quotedRows] = await Promise.all([
    fetchReactions(executor, ids),
    fetchQuoted(executor, { conversationId, quotedIds }),
  ]);
  const reactionsByMessage = groupReactions(reactionRows);
  const quotedByExternalId = indexQuoted(quotedRows);

  return list.map((m) => {
    const quotedId = quotedExternalIdOf(m.content);
    return {
      ...m,
      reactions: reactionsByMessage.get(m.id) ?? [],
      quoted: quotedId ? (quotedByExternalId.get(quotedId) ?? null) : null,
    };
  });
}

/** The list sort key — `sentAt desc nulls last` treats null as oldest, so the range key is coalesced to -infinity. */
const MESSAGE_SORT_KEY = sql`coalesce(${messages.sentAt}, '-infinity'::timestamptz)`;

export async function listMessages(
  db: Database,
  organizationId: string,
  { conversationId, limit }: { conversationId: string; limit: number },
): Promise<MessageWithAuthorRow[]> {
  return withTenant(db, organizationId, async (tx) => {
    // The `limit` NEWEST messages in chronological order — same tail
    // window as listRecentMessages: a long thread must keep its latest
    // messages visible, not its first page.
    const rows = await tx
      .select({ message: messages, authorName: users.name })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.organizationId, organizationId),
        ),
      )
      .orderBy(sql`${messages.sentAt} desc nulls last`, desc(messages.createdAt), desc(messages.id))
      .limit(limit);
    const list = rows.map(({ message, ...rest }) => ({ ...message, ...rest })).reverse();
    return enrichMessages(tx, conversationId, list);
  });
}

export type MessageSearchHit = {
  id: string;
  direction: string;
  preview: string | null;
  sentAt: Date | null;
  createdAt: Date;
};

/**
 * In-thread text search (B1) — matches `content.text`/`content.caption`
 * case-insensitively, newest first. `%`/`_`/`\` are escaped so the query
 * is literal.
 */
export async function searchConversationMessages(
  db: Database,
  organizationId: string,
  { conversationId, query, limit = 20 }: { conversationId: string; query: string; limit?: number },
): Promise<MessageSearchHit[]> {
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%${escaped}%`;
  return withTenant(db, organizationId, (tx) =>
    tx
      .select({
        id: messages.id,
        direction: messages.direction,
        preview: MESSAGE_PREVIEW_SQL,
        sentAt: messages.sentAt,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.organizationId, organizationId),
          sql`(${messages.content} ->> 'text' ilike ${pattern} or ${messages.content} ->> 'caption' ilike ${pattern})`,
        ),
      )
      .orderBy(sql`${MESSAGE_SORT_KEY} desc`, desc(messages.createdAt), desc(messages.id))
      .limit(limit),
  );
}

type WithAuthor = { message: MessageRow; authorName: string | null };
const flattenAuthor = ({ message, ...rest }: WithAuthor) => ({ ...message, ...rest });

/** One side of the jump window, `radius` rows away from the target in sort order. */
function fetchAroundSide(
  tx: DbExecutor,
  scope: {
    organizationId: string;
    conversationId: string;
    target: MessageRow;
    radius: number;
    side: "older" | "newer";
  },
) {
  const { organizationId, conversationId, target, radius, side } = scope;
  // Null sentAt means "oldest" under `desc nulls last` — coalesce mirrors
  // it. ISO strings: postgres.js can't serialize Date params inside raw
  // sql fragments.
  const targetSentAt = target.sentAt?.toISOString() ?? null;
  const targetKey = sql`coalesce(${targetSentAt}::timestamptz, '-infinity'::timestamptz)`;
  const targetCreatedAt = target.createdAt.toISOString();
  const older = side === "older";
  const compare = sql.raw(older ? "<" : ">");
  const order = older
    ? [sql`${MESSAGE_SORT_KEY} desc`, desc(messages.createdAt), desc(messages.id)]
    : [sql`${MESSAGE_SORT_KEY} asc`, asc(messages.createdAt), asc(messages.id)];
  return tx
    .select({ message: messages, authorName: users.name })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.organizationId, organizationId),
        sql`(${MESSAGE_SORT_KEY}, ${messages.createdAt}, ${messages.id}) ${compare} (${targetKey}, ${targetCreatedAt}::timestamptz, ${target.id})`,
      ),
    )
    .orderBy(...order)
    .limit(radius);
}

/**
 * Jump target window (B1): `radius` messages on each side of `messageId`
 * plus the target itself, chronological. Mirrors the `listMessages`
 * ordering (sentAt nulls last ⇒ coalesced to -infinity in the sort key).
 * Returns null when the target isn't in the conversation.
 */
export async function listMessagesAround(
  db: Database,
  organizationId: string,
  {
    conversationId,
    messageId,
    radius = 20,
  }: { conversationId: string; messageId: string; radius?: number },
): Promise<MessageWithAuthorRow[] | null> {
  return withTenant(db, organizationId, async (tx) => {
    const [target] = await tx
      .select({
        message: messages,
        authorName: users.name,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorId))
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.conversationId, conversationId),
          eq(messages.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!target) return null;
    const scope = { organizationId, conversationId, target: target.message, radius };
    const [older, newer] = await Promise.all([
      fetchAroundSide(tx, { ...scope, side: "older" }),
      fetchAroundSide(tx, { ...scope, side: "newer" }),
    ]);
    const list = [
      ...older.map(flattenAuthor).reverse(),
      flattenAuthor(target),
      ...newer.map(flattenAuthor),
    ];
    return enrichMessages(tx, conversationId, list);
  });
}

/**
 * The `limit` NEWEST messages in chronological order — LLM transcript
 * windows (observer/drafter). `listMessages` pages the thread
 * oldest-first; jobs need the tail, where the customer's last message is.
 */
export async function listRecentMessages(
  db: Database,
  organizationId: string,
  { conversationId, limit }: { conversationId: string; limit: number },
): Promise<MessageRow[]> {
  return withTenant(db, organizationId, async (tx) => {
    const rows = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.organizationId, organizationId),
        ),
      )
      .orderBy(sql`${messages.sentAt} desc nulls last`, desc(messages.createdAt))
      .limit(limit);
    return rows.reverse();
  });
}

/** Latest inbound timestamp — draft staleness, independent of any list window. */
export async function getLastInboundAt(
  executor: DbExecutor,
  organizationId: string,
  conversationId: string,
): Promise<Date | null> {
  const [row] = await executor
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.organizationId, organizationId),
        eq(messages.direction, "inbound"),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}
