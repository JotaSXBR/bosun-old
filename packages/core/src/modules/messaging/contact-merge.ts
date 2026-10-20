import type { DbExecutor } from "@crm/db";
import { schema } from "@crm/db";
import type { SQL } from "drizzle-orm";
import { and, eq, ne, notInArray, or, sql } from "drizzle-orm";

import type { ContactRow, ConversationRow } from "./repository";
import { findActiveTicket } from "./repository";

const {
  agentSuggestions,
  contactLabels,
  contacts,
  conversationLabels,
  conversations,
  deals,
  memoryEntries,
  messages,
} = schema;

const isActive = (status: string) => status !== "resolved" && status !== "closed";

/**
 * Auto-reply markers are unique per ticket (per day for off-hours): the ones the
 * twin already has win, so moving the messages never violates those indexes.
 */
async function dropDuplicateMarkers(
  executor: DbExecutor,
  ticket: ConversationRow,
  twin: ConversationRow,
): Promise<void> {
  const twinHas = (marker: string, extra: SQL) =>
    sql`exists (select 1 from messages m where m.conversation_id = ${twin.id} and m.metadata->>'system' = ${marker} ${extra})`;
  await executor
    .delete(messages)
    .where(
      and(
        eq(messages.conversationId, ticket.id),
        or(
          and(
            sql`${messages.metadata}->>'system' = 'unsupported_media'`,
            twinHas("unsupported_media", sql``),
          ),
          and(
            sql`${messages.metadata}->>'system' = 'off_hours'`,
            twinHas(
              "off_hours",
              sql`and m.metadata->>'autoReplyDay' = messages.metadata->>'autoReplyDay'`,
            ),
          ),
        ),
      ),
    );
}

/** Rows hanging off the ticket that would cascade away (or lose their link) with it. */
async function repointTicketChildren(
  executor: DbExecutor,
  ticket: ConversationRow,
  twin: ConversationRow,
): Promise<void> {
  // One deal per conversation: the twin's own deal keeps the link, ours keeps only the contact.
  await executor
    .update(deals)
    .set({ conversationId: twin.id })
    .where(
      and(
        eq(deals.conversationId, ticket.id),
        sql`not exists (select 1 from deals d where d.conversation_id = ${twin.id})`,
      ),
    );
  await executor
    .update(agentSuggestions)
    .set({ sourceConversationId: twin.id })
    .where(eq(agentSuggestions.sourceConversationId, ticket.id));
  await executor
    .update(conversations)
    .set({ precededById: twin.id })
    .where(and(eq(conversations.precededById, ticket.id), ne(conversations.id, twin.id)));
  await executor
    .update(conversationLabels)
    .set({ conversationId: twin.id })
    .where(
      and(
        eq(conversationLabels.conversationId, ticket.id),
        notInArray(
          conversationLabels.labelId,
          executor
            .select({ id: conversationLabels.labelId })
            .from(conversationLabels)
            .where(eq(conversationLabels.conversationId, twin.id)),
        ),
      ),
    );
  // Per-user read cursor: keep the latest one.
  await executor.execute(sql`
    insert into conversation_reads (organization_id, conversation_id, user_id, last_read_at)
    select organization_id, ${twin.id}, user_id, last_read_at
    from conversation_reads where conversation_id = ${ticket.id}
    on conflict (conversation_id, user_id) do update
      set last_read_at = greatest(conversation_reads.last_read_at, excluded.last_read_at)`);
}

/**
 * A chat the same person already holds under the phone: fold the lid ticket's
 * messages into it and drop the empty ticket (one active ticket per chat).
 */
async function foldTicket(
  executor: DbExecutor,
  ticket: ConversationRow,
  twin: ConversationRow,
): Promise<void> {
  await dropDuplicateMarkers(executor, ticket, twin);
  await executor
    .update(messages)
    .set({ conversationId: twin.id })
    .where(eq(messages.conversationId, ticket.id));
  if (ticket.lastMessageAt && (!twin.lastMessageAt || ticket.lastMessageAt > twin.lastMessageAt)) {
    await executor
      .update(conversations)
      .set({
        lastMessageAt: ticket.lastMessageAt,
        lastMessagePreview: ticket.lastMessagePreview,
        lastMessageDirection: ticket.lastMessageDirection,
      })
      .where(eq(conversations.id, twin.id));
  }
  await repointTicketChildren(executor, ticket, twin);
  await executor.delete(conversations).where(eq(conversations.id, ticket.id));
}

async function moveTickets(
  executor: DbExecutor,
  survivor: ContactRow,
  lost: ContactRow,
): Promise<void> {
  const tickets = await executor
    .select()
    .from(conversations)
    .where(eq(conversations.contactId, lost.id));
  for (const ticket of tickets) {
    const twin = isActive(ticket.status)
      ? await findActiveTicket(executor, ticket.channelConnectionId, survivor.channelUserId)
      : undefined;
    if (twin) {
      await foldTicket(executor, ticket, twin);
    } else {
      await executor
        .update(conversations)
        .set({ contactId: survivor.id, externalId: survivor.channelUserId })
        .where(eq(conversations.id, ticket.id));
    }
  }
}

/**
 * Folds the provisional contact keyed by `lid` into `survivor` (the contact
 * keyed by the phone) once WhatsApp told us whose lid it is. Everything the
 * lid contact owned moves to the survivor and the lid row is deleted. Runs in
 * the caller's tenant transaction; a no-op when no such contact exists, so it
 * is safe on every inbound message.
 */
export async function mergeLidContact(
  executor: DbExecutor,
  survivor: ContactRow,
  lid: string,
): Promise<void> {
  const [lost] = await executor
    .select()
    .from(contacts)
    .where(
      and(eq(contacts.organizationId, survivor.organizationId), eq(contacts.channelUserId, lid)),
    )
    .limit(1);
  if (!lost || lost.id === survivor.id) return;

  await moveTickets(executor, survivor, lost);
  await executor
    .update(messages)
    .set({ contactId: survivor.id })
    .where(eq(messages.contactId, lost.id));
  await executor.update(deals).set({ contactId: survivor.id }).where(eq(deals.contactId, lost.id));
  await executor
    .update(memoryEntries)
    .set({ contactId: survivor.id })
    .where(eq(memoryEntries.contactId, lost.id));
  // (contact, label) is unique: labels the survivor already has stay as they are.
  await executor
    .update(contactLabels)
    .set({ contactId: survivor.id })
    .where(
      and(
        eq(contactLabels.contactId, lost.id),
        notInArray(
          contactLabels.labelId,
          executor
            .select({ id: contactLabels.labelId })
            .from(contactLabels)
            .where(eq(contactLabels.contactId, survivor.id)),
        ),
      ),
    );
  await executor
    .update(contacts)
    .set({
      displayName: sql`coalesce(${contacts.displayName}, ${lost.displayName}::text)`,
      avatarUrl: sql`coalesce(${contacts.avatarUrl}, ${lost.avatarUrl}::text)`,
      ticketCounter: sql`greatest(${contacts.ticketCounter}, ${lost.ticketCounter})`,
      metadata: sql`${JSON.stringify(lost.metadata)}::jsonb || ${contacts.metadata}`,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, survivor.id));
  await executor.delete(contacts).where(eq(contacts.id, lost.id));
}
