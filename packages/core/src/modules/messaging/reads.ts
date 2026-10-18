import type { Database, DbExecutor } from "@crm/db";
import { schema, withTenant } from "@crm/db";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { ConversationRow, MessageRow } from "./repository";
import type { ConversationView } from "./schemas";

const { contacts, conversationReads, conversations, messageReactions, messages, teams, users } =
  schema;

/** A conversation row plus the contact identity and a one-line preview. */
export type ConversationListRow = ConversationRow & {
  contactDisplayName: string | null;
  contactChannelUserId: string;
  contactAvatarUrl: string | null;
  assigneeName: string | null;
  sectorName: string | null;
  lastMessagePreview: string | null;
  /** Last message inbound — the "needs reply" dot on the row. */
  awaitingReply: boolean;
  /** Inbound messages newer than the caller's read cursor. */
  unreadCount: number;
  /** Media kind of the last channel message — icon on the row preview. */
  lastMessageMediaKind: string | null;
};

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

/** Conversation plus contact identity, names and the preceding ticket's numbers. */
export type ConversationDetailRow = ConversationRow & {
  contactDisplayName: string | null;
  contactChannelUserId: string;
  contactAvatarUrl: string | null;
  /** Ficha fields (email/phone/notes) live in the contacts jsonb bag. */
  contactMetadata: Record<string, unknown>;
  assigneeName: string | null;
  sectorName: string | null;
  precededTicketNumber: number | null;
  precededTicketSeq: number | null;
};

export const ACTIVE_STATUSES = sql`${conversations.status} not in ('resolved', 'closed')`;
const TERMINAL_STATUSES = sql`${conversations.status} in ('resolved', 'closed')`;
/** Deferred rows leave the work views until the instant passes — lazy un-snooze. */
const NOT_SNOOZED = sql`(${conversations.snoozedUntil} is null or ${conversations.snoozedUntil} <= now())`;
const SNOOZED = sql`(${conversations.snoozedUntil} > now())`;
/**
 * Latest-message preview/direction are denormalized columns on
 * conversations — written wherever lastMessageAt is bumped and refreshed
 * on message edit/revoke. The inbox list reads them directly: zero
 * correlated probes per row, private notes excluded by construction.
 */

/** Search across contact name, channel user id (phone), external id and ticket #. */
function searchFilter(search: string | undefined) {
  if (!search) return undefined;
  const pattern = `%${search}%`;
  return sql`(${contacts.displayName} ilike ${pattern} or ${contacts.channelUserId} ilike ${pattern} or ${conversations.externalId} ilike ${pattern} or ${conversations.ticketNumber}::text ilike ${pattern})`;
}

/**
 * Inbox views (spec docs/product/inbox.md). Snoozed rows only appear in
 * `snoozed`; ordering surfaces the longest wait where the queue works it.
 */
export async function listConversations(
  db: Database,
  organizationId: string,
  opts: {
    view: ConversationView;
    limit: number;
    userId: string;
    search?: string;
    channelConnectionId?: string;
    sectorId?: string;
    awaitingReply?: boolean;
  },
): Promise<ConversationListRow[]> {
  const viewFilter =
    opts.view === "pending"
      ? eq(conversations.status, "pending")
      : opts.view === "queue"
        ? and(eq(conversations.status, "open"), isNull(conversations.assigneeId), NOT_SNOOZED)
        : opts.view === "mine"
          ? and(eq(conversations.assigneeId, opts.userId), ACTIVE_STATUSES, NOT_SNOOZED)
          : opts.view === "snoozed"
            ? and(ACTIVE_STATUSES, SNOOZED)
            : opts.view === "closed"
              ? TERMINAL_STATUSES
              : and(ACTIVE_STATUSES, NOT_SNOOZED);
  const filters = and(
    viewFilter,
    searchFilter(opts.search),
    opts.channelConnectionId
      ? eq(conversations.channelConnectionId, opts.channelConnectionId)
      : undefined,
    opts.sectorId ? eq(conversations.sectorId, opts.sectorId) : undefined,
    opts.awaitingReply ? eq(conversations.lastMessageDirection, "inbound") : undefined,
  );
  const order =
    opts.view === "closed"
      ? desc(conversations.resolvedAt)
      : opts.view === "all"
        ? desc(conversations.lastMessageAt)
        : // Work views: longest wait first — fresh tickets (null) sit at the top.
          sql`${conversations.lastMessageAt} asc nulls first`;
  const rows = await withTenant(db, organizationId, (tx) =>
    tx
      .select({
        conversation: conversations,
        contactDisplayName: contacts.displayName,
        contactChannelUserId: contacts.channelUserId,
        contactAvatarUrl: contacts.avatarUrl,
        assigneeName: users.name,
        sectorName: teams.name,
        // Correlated count is index-served by
        // messages_conversation_inbound_created_idx (~list-limit rows).
        unreadCount: sql<number>`(select count(*)::int from messages m
          where m.conversation_id = ${conversations.id}
            and m.direction = 'inbound'
            and m.created_at > coalesce(${conversationReads.lastReadAt}, '-infinity'::timestamptz))`,
        // Same tail probe the denormalized preview mirrors — kept as a
        // subquery because media kind is read-often, write-never. Stickers
        // arrive as image/webp — surfaced as the pseudo-kind "sticker".
        lastMessageMediaKind: sql<string | null>`(select
          case when m.content ->> 'mediaKind' = 'image'
                and m.content ->> 'mimeType' = 'image/webp' then 'sticker'
               else m.content ->> 'mediaKind' end
          from messages m
          where m.conversation_id = ${conversations.id}
            and m."private" is not true
          order by m.sent_at desc nulls last, m.created_at desc limit 1)`,
      })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .leftJoin(users, eq(users.id, conversations.assigneeId))
      .leftJoin(teams, eq(teams.id, conversations.sectorId))
      .leftJoin(
        conversationReads,
        and(
          eq(conversationReads.conversationId, conversations.id),
          eq(conversationReads.userId, opts.userId),
        ),
      )
      .where(filters)
      .orderBy(order)
      .limit(opts.limit),
  );
  return rows.map(({ conversation, ...rest }) => ({
    ...conversation,
    ...rest,
    awaitingReply: conversation.lastMessageDirection === "inbound",
  }));
}

/** Prior ticket of a contact — the aside's conversation history list. */
export type ContactTicketRow = {
  id: string;
  ticketNumber: number;
  ticketSeq: number;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  lastMessagePreview: string | null;
};

/** Tickets of a contact, newest first — excludes the open conversation. */
export async function listContactTickets(
  db: Database,
  organizationId: string,
  {
    contactId,
    excludeConversationId,
    limit = 10,
  }: { contactId: string; excludeConversationId: string; limit?: number },
): Promise<ContactTicketRow[]> {
  return withTenant(db, organizationId, (tx) =>
    tx
      .select({
        id: conversations.id,
        ticketNumber: conversations.ticketNumber,
        ticketSeq: conversations.ticketSeq,
        status: conversations.status,
        createdAt: conversations.createdAt,
        resolvedAt: conversations.resolvedAt,
        lastMessagePreview: conversations.lastMessagePreview,
      })
      .from(conversations)
      .where(
        and(eq(conversations.contactId, contactId), ne(conversations.id, excludeConversationId)),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(limit),
  );
}

/** Per-tab counters — one grouped scan, no N queries. */
export async function listConversationViewCounts(
  db: Database,
  organizationId: string,
  userId: string,
): Promise<Record<ConversationView, number>> {
  const [row] = await withTenant(db, organizationId, (tx) =>
    tx
      .select({
        pending: sql<number>`(count(*) filter (where ${conversations.status} = 'pending'))::int`,
        queue: sql<number>`(count(*) filter (where ${conversations.status} = 'open' and ${conversations.assigneeId} is null and ${NOT_SNOOZED}))::int`,
        mine: sql<number>`(count(*) filter (where ${conversations.assigneeId} = ${userId} and ${ACTIVE_STATUSES} and ${NOT_SNOOZED}))::int`,
        all: sql<number>`(count(*) filter (where ${ACTIVE_STATUSES} and ${NOT_SNOOZED}))::int`,
        snoozed: sql<number>`(count(*) filter (where ${ACTIVE_STATUSES} and ${SNOOZED}))::int`,
        closed: sql<number>`(count(*) filter (where ${TERMINAL_STATUSES}))::int`,
      })
      .from(conversations),
  );
  return row ?? { pending: 0, queue: 0, mine: 0, all: 0, snoozed: 0, closed: 0 };
}

const MESSAGE_PREVIEW_SQL = sql<
  string | null
>`coalesce(${messages.content} ->> 'text', ${messages.content} ->> 'caption', '[' || (${messages.content} ->> 'type') || ']')`;

/** externalId this message quotes — set on text and media contents. */
function quotedExternalIdOf(content: unknown): string | null {
  if (typeof content !== "object" || content === null) return null;
  const quoted = (content as Record<string, unknown>).quotedExternalId;
  return typeof quoted === "string" && quoted.length > 0 ? quoted : null;
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
    ids.length === 0
      ? Promise.resolve([])
      : executor
          .select()
          .from(messageReactions)
          .where(inArray(messageReactions.messageId, ids))
          .orderBy(asc(messageReactions.createdAt)),
    quotedIds.length === 0
      ? Promise.resolve([])
      : executor
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
            and(
              eq(messages.conversationId, conversationId),
              inArray(messages.externalId, quotedIds),
            ),
          ),
  ]);

  const reactionsByMessage = new Map<string, MessageReactionView[]>();
  for (const r of reactionRows) {
    const bucket = reactionsByMessage.get(r.messageId) ?? [];
    bucket.push({
      emoji: r.emoji,
      reactorKey: r.reactorKey,
      fromMe: r.fromMe,
      actorUserId: r.actorUserId,
    });
    reactionsByMessage.set(r.messageId, bucket);
  }
  const quotedByExternalId = new Map(
    quotedRows
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

    // Null sentAt means "oldest" under `desc nulls last` — coalesce mirrors
    // it. ISO strings: postgres.js can't serialize Date params inside raw
    // sql fragments.
    const targetSentAt = target.message.sentAt?.toISOString() ?? null;
    const targetCreatedAt = target.message.createdAt.toISOString();
    const targetKey = sql`coalesce(${targetSentAt}::timestamptz, '-infinity'::timestamptz)`;
    const [older, newer] = await Promise.all([
      tx
        .select({ message: messages, authorName: users.name })
        .from(messages)
        .leftJoin(users, eq(users.id, messages.authorId))
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.organizationId, organizationId),
            sql`(${MESSAGE_SORT_KEY}, ${messages.createdAt}, ${messages.id}) < (${targetKey}, ${targetCreatedAt}::timestamptz, ${target.message.id})`,
          ),
        )
        .orderBy(sql`${MESSAGE_SORT_KEY} desc`, desc(messages.createdAt), desc(messages.id))
        .limit(radius),
      tx
        .select({ message: messages, authorName: users.name })
        .from(messages)
        .leftJoin(users, eq(users.id, messages.authorId))
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.organizationId, organizationId),
            sql`(${MESSAGE_SORT_KEY}, ${messages.createdAt}, ${messages.id}) > (${targetKey}, ${targetCreatedAt}::timestamptz, ${target.message.id})`,
          ),
        )
        .orderBy(sql`${MESSAGE_SORT_KEY} asc`, asc(messages.createdAt), asc(messages.id))
        .limit(radius),
    ]);

    const list = [
      ...older.map(({ message, ...rest }) => ({ ...message, ...rest })).reverse(),
      { ...target.message, authorName: target.authorName },
      ...newer.map(({ message, ...rest }) => ({ ...message, ...rest })),
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

/** Detail fetch for the conversation page: contact + preceding ticket numbers. */
export async function getConversationDetail(
  executor: DbExecutor,
  conversationId: string,
): Promise<ConversationDetailRow | undefined> {
  const preceded = alias(conversations, "preceded");
  const [row] = await executor
    .select({
      conversation: conversations,
      contactDisplayName: contacts.displayName,
      contactChannelUserId: contacts.channelUserId,
      contactAvatarUrl: contacts.avatarUrl,
      contactMetadata: contacts.metadata,
      assigneeName: users.name,
      sectorName: teams.name,
      precededTicketNumber: preceded.ticketNumber,
      precededTicketSeq: preceded.ticketSeq,
    })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(users, eq(users.id, conversations.assigneeId))
    .leftJoin(teams, eq(teams.id, conversations.sectorId))
    .leftJoin(preceded, eq(preceded.id, conversations.precededById))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row) return undefined;
  const { conversation, ...rest } = row;
  return { ...conversation, ...rest };
}
