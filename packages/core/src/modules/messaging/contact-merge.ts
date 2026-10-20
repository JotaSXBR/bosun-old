import type { DbExecutor } from "@crm/db";
import { schema } from "@crm/db";
import { and, eq, notInArray, sql } from "drizzle-orm";

import type { ContactRow, ConversationRow } from "./repository";
import { findActiveTicket } from "./repository";

const { contactLabels, contacts, conversations, deals, memoryEntries, messages } = schema;

const isActive = (status: string) => status !== "resolved" && status !== "closed";

/**
 * A chat the same person already holds under the phone: fold the lid ticket's
 * messages into it and drop the empty ticket (one active ticket per chat).
 */
async function foldTicket(
  executor: DbExecutor,
  ticket: ConversationRow,
  twin: ConversationRow,
): Promise<void> {
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
  // A deal pointing at the dropped ticket keeps the contact and loses only the link (FK set null).
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
