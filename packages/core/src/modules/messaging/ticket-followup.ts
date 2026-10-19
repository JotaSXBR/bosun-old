import type { Database, DbExecutor } from "@crm/db";
import { emitDomainEvent, withTenant } from "@crm/db";

import { DomainError, NotFoundError } from "../../errors";
import { isUniqueViolation } from "../../lib/pg-error";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { findSettings } from "../organizations";
import type { ConversationRow } from "./repository";
import { createFollowupTicket, findActiveTicket, getConversation } from "./repository";
import type { ConversationIdInput } from "./schemas";
import { conversationIdInput } from "./schemas";
import { patchTicket } from "./ticket-patch";

const activeTicketExists = () =>
  new DomainError(
    "ACTIVE_TICKET_EXISTS",
    "This chat already has an active follow-up ticket — work that one instead",
  );

async function assertNoActiveTicket(tx: DbExecutor, conv: ConversationRow): Promise<void> {
  const active = await findActiveTicket(tx, conv.channelConnectionId, conv.externalId);
  if (active) throw activeTicketExists();
}

/**
 * A concurrent inbound may have committed a follow-up between the active
 * check and the write — the partial unique index still blocks two active
 * tickets; surface it as the same domain error.
 */
function translateActiveTicketRace(error: unknown): never {
  if (isUniqueViolation(error, "conversations_connection_external_idx")) {
    throw activeTicketExists();
  }
  throw error;
}

async function assertWithinReopenWindow(
  tx: DbExecutor,
  organizationId: string,
  conv: ConversationRow,
): Promise<void> {
  // resolved_at null = resolved before the column existed — no measurable
  // age, so the window can't apply; allow the reopen.
  if (!conv.resolvedAt) return;
  const settings = await findSettings(tx, organizationId);
  const hours = settings?.ticketReopenWindowHours ?? 48;
  const ageMs = Date.now() - conv.resolvedAt.getTime();
  if (ageMs > hours * 3_600_000) {
    throw new DomainError(
      "REOPEN_WINDOW_EXPIRED",
      `Reopen window expired — resolved tickets close after ${hours}h; open a follow-up instead`,
    );
  }
}

/**
 * Requires messaging:write. Reopens a resolved ticket — the "I closed it by
 * accident" undo. Any agent may reopen (the action is audited, not gated).
 *
 * Guards: the ticket must be `resolved`; the org-configured reopen window
 * (`ticket_reopen_window_hours`, default 48h) must not have expired — past
 * it the ticket is effectively closed; and NO active ticket may exist for
 * the chat (a follow-up already took over — work it instead). Reopening
 * keeps the assignee (in_progress) or returns to the queue (open) and
 * clears the resolution stamps; ticket_number/ticket_seq are unchanged —
 * it is the same ticket continuing.
 */
export async function reopenTicket(
  db: Database,
  ctx: TenantContext,
  input: ConversationIdInput,
): Promise<ConversationRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const { conversationId } = conversationIdInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    const conv = await getConversation(tx, conversationId);
    if (!conv) throw new NotFoundError("Conversation", conversationId);
    if (conv.status !== "resolved") {
      throw new DomainError("TICKET_NOT_RESOLVED", "Only resolved tickets can be reopened");
    }
    await assertWithinReopenWindow(tx, ctx.organizationId, conv);
    await assertNoActiveTicket(tx, conv);
    return patchTicket(tx, ctx.organizationId, {
      conversationId,
      patch: {
        status: conv.assigneeId ? "in_progress" : "open",
        resolvedAt: null,
        resolvedById: null,
      },
    }).catch(translateActiveTicketRace);
  });
}

/**
 * Requires messaging:write. Creates a follow-up ticket from a resolved or
 * closed one — linked via preceded_by_id, assigned to the caller and already
 * in_progress (the agent resumed it to keep working). This is the only way
 * to re-engage a `closed` ticket — reopen is windowed off resolved rows.
 */
export async function resumeTicket(
  db: Database,
  ctx: TenantContext,
  input: ConversationIdInput,
): Promise<ConversationRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const { conversationId } = conversationIdInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    const source = await getConversation(tx, conversationId);
    if (!source) throw new NotFoundError("Conversation", conversationId);
    if (source.status !== "resolved" && source.status !== "closed") {
      throw new DomainError(
        "TICKET_NOT_RESOLVED",
        "Follow-up only applies to resolved/closed tickets — the ticket is still active",
      );
    }
    await assertNoActiveTicket(tx, source);
    const ticket = await createFollowupTicket(
      tx,
      {
        organizationId: ctx.organizationId,
        channelConnectionId: source.channelConnectionId,
        contactId: source.contactId,
        externalId: source.externalId,
        assigneeId: ctx.userId,
        status: "in_progress",
      },
      source.id,
    ).catch(translateActiveTicketRace);
    await emitDomainEvent(tx, {
      type: "conversation.created",
      organizationId: ctx.organizationId,
      conversationId: ticket.id,
      contactId: ticket.contactId,
      ticketNumber: ticket.ticketNumber,
      precededById: ticket.precededById,
    });
    return ticket;
  });
}
