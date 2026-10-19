import type { Database, DbExecutor } from "@crm/db";
import { schema, withTenant } from "@crm/db";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { ConversationRow } from "./repository";
export * from "./reads-messages";
import type { ConversationView } from "./schemas";

const { contacts, conversationReads, conversations, teams, users } = schema;

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
function viewFilter(view: ConversationView, userId: string) {
  switch (view) {
    case "pending":
      return eq(conversations.status, "pending");
    case "queue":
      return and(eq(conversations.status, "open"), isNull(conversations.assigneeId), NOT_SNOOZED);
    case "mine":
      return and(eq(conversations.assigneeId, userId), ACTIVE_STATUSES, NOT_SNOOZED);
    case "snoozed":
      return and(ACTIVE_STATUSES, SNOOZED);
    case "closed":
      return TERMINAL_STATUSES;
    default:
      return and(ACTIVE_STATUSES, NOT_SNOOZED);
  }
}

function viewOrder(view: ConversationView) {
  if (view === "closed") return desc(conversations.resolvedAt);
  if (view === "all") return desc(conversations.lastMessageAt);
  // Work views: longest wait first — fresh tickets (null) sit at the top.
  return sql`${conversations.lastMessageAt} asc nulls first`;
}

const LIST_COLUMNS = {
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
};

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
  const filters = and(
    viewFilter(opts.view, opts.userId),
    searchFilter(opts.search),
    opts.channelConnectionId
      ? eq(conversations.channelConnectionId, opts.channelConnectionId)
      : undefined,
    opts.sectorId ? eq(conversations.sectorId, opts.sectorId) : undefined,
    opts.awaitingReply ? eq(conversations.lastMessageDirection, "inbound") : undefined,
  );
  const rows = await withTenant(db, organizationId, (tx) =>
    tx
      .select(LIST_COLUMNS)
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
      .orderBy(viewOrder(opts.view))
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
