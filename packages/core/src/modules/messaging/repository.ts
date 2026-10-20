import type { DbExecutor } from "@crm/db";
import { schema } from "@crm/db";
import { and, desc, eq, sql } from "drizzle-orm";

const {
  channelConnections,
  contacts,
  conversationReads,
  conversations,
  organizationMembers,
  teams,
  ticketCounters,
} = schema;

export type ContactRow = typeof contacts.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type ChannelConnectionRow = typeof channelConnections.$inferSelect;

// Message-scoped helpers live in repository-messages.ts — re-exported here
// so existing `./repository` imports keep working.
export type { MessageEditRow, MessageReactionRow, MessageRow } from "./repository-messages";
export {
  applyMessageEdit,
  findMessageByExternalIds,
  getMessage,
  insertMessage,
  listMessageEdits,
  listReactionsForMessages,
  markMessageRevoked,
  mergeMessageMetadata,
  updateMessageStatus,
  upsertMessageReaction,
} from "./repository-messages";

/**
 * Finds or creates the contact for (organizationId, channelUserId). When the
 * event carries a displayName it fills/refreshes the stored one; an absent
 * name never overwrites an existing one.
 */
export async function upsertContact(
  executor: DbExecutor,
  organizationId: string,
  values: {
    channelUserId: string;
    displayName?: string | undefined;
    /**
     * The incoming name only fills a missing one. WhatsApp push names must not
     * overwrite an attendant rename, and one company number is written by
     * several people whose push names differ.
     */
    nameOnlyIfNew?: boolean | undefined;
    /** Shallow-merged into the stored metadata jsonb (new keys win). */
    metadata?: Record<string, unknown> | undefined;
  },
): Promise<ContactRow> {
  const [row] = await executor
    .insert(contacts)
    .values({
      organizationId,
      channelUserId: values.channelUserId,
      displayName: values.displayName ?? null,
      metadata: values.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [contacts.organizationId, contacts.channelUserId],
      set: {
        displayName: values.nameOnlyIfNew
          ? sql`coalesce(${contacts.displayName}, excluded.display_name)`
          : sql`coalesce(excluded.display_name, ${contacts.displayName})`,
        metadata: sql`${contacts.metadata} || excluded.metadata`,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("contacts upsert returned no row");
  return row;
}

/**
 * Bumps the user's read cursor on a conversation to now(). Upsert keyed on
 * (conversation_id, user_id) — one row per reader per ticket.
 */
export async function upsertConversationRead(
  executor: DbExecutor,
  values: { organizationId: string; conversationId: string; userId: string },
): Promise<void> {
  await executor
    .insert(conversationReads)
    .values(values)
    .onConflictDoUpdate({
      target: [conversationReads.conversationId, conversationReads.userId],
      set: { lastReadAt: new Date() },
    });
}

/** The single active (non-terminal) ticket for a chat, if one exists. */
export async function findActiveTicket(
  executor: DbExecutor,
  channelConnectionId: string,
  externalId: string,
): Promise<ConversationRow | undefined> {
  const [row] = await executor
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.channelConnectionId, channelConnectionId),
        eq(conversations.externalId, externalId),
        sql`${conversations.status} not in ('resolved', 'closed')`,
      ),
    )
    .limit(1);
  return row;
}

/** Latest terminal (resolved/closed) ticket for a chat — the predecessor a follow-up links to. */
async function latestResolvedTicket(
  executor: DbExecutor,
  channelConnectionId: string,
  externalId: string,
): Promise<string | null> {
  const [row] = await executor
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.channelConnectionId, channelConnectionId),
        eq(conversations.externalId, externalId),
        sql`${conversations.status} in ('resolved', 'closed')`,
      ),
    )
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Inserts a ticket assigning both sequences atomically in this tx:
 * `ticket_number` from the org counter row, `ticket_seq` from the contact's
 * counter. Returns undefined when an active ticket already exists
 * (concurrent insert won the partial-unique race).
 */
async function insertTicket(
  executor: DbExecutor,
  values: {
    organizationId: string;
    channelConnectionId: string;
    contactId: string;
    externalId: string;
    assigneeId?: string | null;
    status?: string;
  },
  precededById: string | null,
): Promise<ConversationRow | undefined> {
  const [counter] = await executor
    .insert(ticketCounters)
    .values({ organizationId: values.organizationId, value: 1 })
    .onConflictDoUpdate({
      target: ticketCounters.organizationId,
      set: { value: sql`${ticketCounters.value} + 1` },
    })
    .returning({ value: ticketCounters.value });
  const [contact] = await executor
    .update(contacts)
    .set({ ticketCounter: sql`${contacts.ticketCounter} + 1`, updatedAt: new Date() })
    .where(eq(contacts.id, values.contactId))
    .returning({ seq: contacts.ticketCounter });
  if (!counter || !contact) {
    throw new Error("ticket counters returned no row");
  }
  const [row] = await executor
    .insert(conversations)
    .values({
      ...values,
      status: values.status ?? "open",
      precededById,
      ticketNumber: counter.value,
      ticketSeq: contact.seq,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

/**
 * Ticket semantics (Zendesk-style): `resolved` is terminal, so an inbound on
 * a resolved chat creates a NEW open ticket linked via `preceded_by_id` —
 * fresh queue, no sector/assignee carry-over. Returns `created` so callers
 * can emit `conversation.created`.
 */
export async function findOrCreateTicket(
  executor: DbExecutor,
  values: {
    organizationId: string;
    channelConnectionId: string;
    contactId: string;
    externalId: string;
    assigneeId?: string | null;
    status?: string;
  },
): Promise<{ conversation: ConversationRow; created: boolean }> {
  const existing = await findActiveTicket(executor, values.channelConnectionId, values.externalId);
  if (existing) return { conversation: existing, created: false };
  const precededById = await latestResolvedTicket(
    executor,
    values.channelConnectionId,
    values.externalId,
  );
  const created = await insertTicket(executor, values, precededById);
  if (created) return { conversation: created, created: true };
  // Lost the insert race — the winner's active row is now visible.
  const winner = await findActiveTicket(executor, values.channelConnectionId, values.externalId);
  if (!winner) throw new Error("ticket insert raced and no active row found");
  return { conversation: winner, created: false };
}

/**
 * Explicit follow-up of a resolved ticket (`resumeTicket` action): new open
 * ticket for the same chat, linked to `source`. Throws when an active ticket
 * already exists for the chat.
 */
export async function createFollowupTicket(
  executor: DbExecutor,
  values: {
    organizationId: string;
    channelConnectionId: string;
    contactId: string;
    externalId: string;
    assigneeId: string | null;
    status?: string;
  },
  sourceId: string,
): Promise<ConversationRow> {
  const active = await findActiveTicket(executor, values.channelConnectionId, values.externalId);
  if (active) throw new Error("chat already has an active ticket");
  const row = await insertTicket(executor, values, sourceId);
  if (!row) throw new Error("follow-up ticket insert raced");
  return row;
}

/**
 * Inbound message landed on an ACTIVE ticket: `waiting_customer` returns to
 * `in_progress`. Resolved tickets never reach here — a resolved chat yields a
 * new ticket in findOrCreateTicket. No-op for other statuses — returns the
 * updated row when a transition happened, undefined otherwise.
 */
export async function applyInboundStatusTransition(
  executor: DbExecutor,
  conversationId: string,
  currentStatus: string,
): Promise<ConversationRow | undefined> {
  if (currentStatus !== "waiting_customer") return undefined;
  const [row] = await executor
    .update(conversations)
    .set({ status: "in_progress", updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
    .returning();
  return row;
}

/** Tenant-scoped contact lookup for ticket creation (call inside withTenant). */
export async function findContactForTicket(
  executor: DbExecutor,
  contactId: string,
): Promise<ContactRow | undefined> {
  const [row] = await executor.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  return row;
}

/** Tenant-scoped connection lookup (call inside withTenant). */
export async function findConnectionById(
  executor: DbExecutor,
  connectionId: string,
): Promise<ChannelConnectionRow | undefined> {
  const [row] = await executor
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.id, connectionId))
    .limit(1);
  return row;
}

export async function getConversation(
  executor: DbExecutor,
  conversationId: string,
): Promise<ConversationRow | undefined> {
  const [row] = await executor
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row;
}

/** organization_members has no RLS — the caller scopes the org id. */
export async function isOrgMember(
  executor: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** teams is RLS-scoped — found means it belongs to this tenant. */
export async function teamExists(executor: DbExecutor, teamId: string): Promise<boolean> {
  const [row] = await executor
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  return row !== undefined;
}

/**
 * Applies a state patch to a ticket. `undefined` fields are left untouched by
 * drizzle; pass explicit `null` to clear assignee/sector.
 */
export async function updateConversationState(
  executor: DbExecutor,
  conversationId: string,
  patch: {
    status?: string;
    assigneeId?: string | null;
    sectorId?: string | null;
    resolvedAt?: Date | null;
    resolvedById?: string | null;
    firstResponseAt?: Date | null;
    snoozedUntil?: Date | null;
  },
): Promise<ConversationRow | undefined> {
  const [row] = await executor
    .update(conversations)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
    .returning();
  return row;
}

/** Latest ticket of a chat regardless of status — the widget's visible thread. */
export async function findLatestConversationForChat(
  executor: DbExecutor,
  channelConnectionId: string,
  externalId: string,
): Promise<ConversationRow | undefined> {
  const [row] = await executor
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.channelConnectionId, channelConnectionId),
        eq(conversations.externalId, externalId),
      ),
    )
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  return row;
}

export * from "./repository-last-message";
export * from "./repository-sitechat";
