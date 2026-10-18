// Ticket actions (multi-atendimento) — all require messaging:write, denied
// to viewer. Resolved tickets are immutable to regular actions
// (TICKET_RESOLVED); the only exception is reopenTicket, which undoes a
// resolution inside the org's reopen window when no follow-up is active.
import type { ChannelProvider } from "@crm/channels";
import { providerForConnection } from "@crm/core/integrations";
import type { Database, DbExecutor } from "@crm/db";
import { emitDomainEvent, withTenant } from "@crm/db";
import { captureException } from "@crm/observability";

import { DomainError, NotFoundError } from "../../errors";
import { isUniqueViolation } from "../../lib/pg-error";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { findSettings } from "../organizations";
import { getUserPreferences } from "../users";
import type { ConversationRow } from "./repository";
import {
  createFollowupTicket,
  findActiveTicket,
  getConversation,
  insertMessage,
  isOrgMember,
  teamExists,
  updateConversationState,
} from "./repository";
import type {
  ConversationIdInput,
  SnoozeConversationInput,
  TransferConversationInput,
} from "./schemas";
import { conversationIdInput, snoozeConversationInput, transferConversationInput } from "./schemas";

/**
 * A ticket in attendance belongs to its assignee — everyone else takes the
 * explicit, audited path: transferConversation (the transfer itself is
 * recorded in the ticket timeline). Unassigned tickets are open to all.
 * Shared with ./outbound (module-internal export, not public surface).
 */
export function assertTicketOwner(conv: ConversationRow, ctx: TenantContext): void {
  if (conv.assigneeId && conv.assigneeId !== ctx.userId) {
    throw new DomainError(
      "TICKET_ASSIGNED",
      "Ticket is assigned to another agent — transfer it to yourself first",
    );
  }
}

/**
 * Loads a ticket for a write action inside the caller's withTenant tx.
 * Resolved/closed tickets are immutable history — regular actions reject
 * them (reopenTicket is the only caller that loads resolved rows directly).
 */
export async function loadActiveTicket(
  executor: DbExecutor,
  conversationId: string,
): Promise<ConversationRow> {
  const conv = await getConversation(executor, conversationId);
  if (!conv) throw new NotFoundError("Conversation", conversationId);
  if (conv.status === "resolved" || conv.status === "closed") {
    throw new DomainError(
      "TICKET_RESOLVED",
      "Resolved tickets are immutable — the next contact opens a follow-up ticket",
    );
  }
  return conv;
}

export async function patchTicket(
  executor: DbExecutor,
  organizationId: string,
  {
    conversationId,
    patch,
  }: { conversationId: string; patch: Parameters<typeof updateConversationState>[2] },
): Promise<ConversationRow> {
  const conv = await updateConversationState(executor, conversationId, patch);
  if (!conv) throw new NotFoundError("Conversation", conversationId);
  await emitDomainEvent(executor, {
    type: "conversation.updated",
    organizationId,
    conversationId: conv.id,
    status: conv.status,
    assigneeId: conv.assigneeId,
    sectorId: conv.sectorId,
  });
  return conv;
}

/**
 * Requires messaging:write. Claims a FREE ticket: assignee = caller,
 * in_progress. Tickets already assigned to another agent reject — ownership
 * changes hands only via an explicit (audited) transferConversation.
 *
 * sendSeen fires only here — opening/viewing a conversation never marks it
 * read; assuming the ticket does. The agent's `sendSeen` preference gates
 * the tick. Best-effort: a provider hiccup must not fail the pickup.
 */
export async function pickupConversation(
  db: Database,
  ctx: TenantContext,
  { input, deps }: { input: ConversationIdInput; deps?: { provider?: ChannelProvider } },
): Promise<ConversationRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const { conversationId } = conversationIdInput.parse(input);
  const ticket = await withTenant(db, ctx.organizationId, async (tx) => {
    const conv = await loadActiveTicket(tx, conversationId);
    assertTicketOwner(conv, ctx);
    return patchTicket(tx, ctx.organizationId, {
      conversationId,
      patch: {
        status: "in_progress",
        assigneeId: ctx.userId,
      },
    });
  });
  try {
    const { sendSeen } = await getUserPreferences(db, ctx.userId);
    if (sendSeen) {
      const provider =
        deps?.provider ??
        (await providerForConnection(db, ctx.organizationId, ticket.channelConnectionId));
      await provider.sendSeen?.(ticket.externalId);
    }
  } catch (error) {
    captureException(error, { op: "pickup.sendSeen", conversationId: ticket.id });
  }
  return ticket;
}

/**
 * Requires messaging:write. `assigneeId` transfers to a member (in_progress,
 * sector kept); `sectorId` moves the ticket to a team's queue (open,
 * unassigned). Exactly one target is required.
 */
export async function transferConversation(
  db: Database,
  ctx: TenantContext,
  input: TransferConversationInput,
): Promise<ConversationRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const parsed = transferConversationInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    const conv = await loadActiveTicket(tx, parsed.conversationId);
    const toAssignee = "assigneeId" in parsed ? parsed.assigneeId : null;
    const toSector = "sectorId" in parsed ? parsed.sectorId : null;
    if (toAssignee) {
      if (!(await isOrgMember(tx, ctx.organizationId, toAssignee))) {
        throw new DomainError("NOT_ORG_MEMBER", "User is not a member of this organization");
      }
    } else if (toSector === null || !(await teamExists(tx, toSector))) {
      throw new NotFoundError("Team", toSector ?? undefined);
    }
    const updated = await patchTicket(tx, ctx.organizationId, {
      conversationId: parsed.conversationId,
      patch: {
        status: toAssignee ? "in_progress" : "open",
        assigneeId: toAssignee,
        sectorId: toSector ?? conv.sectorId,
      },
    });
    // Audited takeover, invisible to the customer: a private system note in
    // the ticket timeline records who moved it and to whom/where.
    await insertMessage(tx, {
      organizationId: ctx.organizationId,
      conversationId: conv.id,
      channelConnectionId: conv.channelConnectionId,
      contactId: null,
      direction: "outbound",
      content: { type: "text", text: "Ticket transferido" },
      externalId: null,
      status: "sent",
      sentAt: new Date(),
      private: true,
      authorId: ctx.userId,
      metadata: {
        system: "transfer",
        fromAssigneeId: conv.assigneeId,
        toAssigneeId: toAssignee,
        toSectorId: toSector,
      },
    });
    return updated;
  });
}

/**
 * Job enqueue callback injected by the app layer (`@crm/automation` lives
 * above core — dependency direction forbids importing it here). Called with
 * the resolve transaction so the observer job row commits atomically.
 */
export type ResolvedEnqueue = (
  executor: DbExecutor,
  payload: { organizationId: string; conversationId: string },
) => Promise<unknown>;

export type ResolveDeps = { enqueue?: ResolvedEnqueue };

/**
 * Requires messaging:write. Closes the ticket — terminal for the customer,
 * reopenable by agents inside the reopen window (reopenTicket).
 * `deps.enqueue` fires the AI observer on the resolved conversation.
 */
export async function resolveConversation(
  db: Database,
  ctx: TenantContext,
  { input, deps }: { input: ConversationIdInput; deps?: ResolveDeps },
): Promise<ConversationRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const { conversationId } = conversationIdInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    const conv = await loadActiveTicket(tx, conversationId);
    assertTicketOwner(conv, ctx);
    const updated = await patchTicket(tx, ctx.organizationId, {
      conversationId,
      patch: {
        status: "resolved",
        resolvedAt: new Date(),
        resolvedById: ctx.userId,
      },
    });
    await deps?.enqueue?.(tx, {
      organizationId: ctx.organizationId,
      conversationId,
    });
    return updated;
  });
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
    // resolved_at null = resolved before the column existed — no measurable
    // age, so the window can't apply; allow the reopen.
    if (conv.resolvedAt) {
      const settings = await findSettings(tx, ctx.organizationId);
      const hours = settings?.ticketReopenWindowHours ?? 48;
      const ageMs = Date.now() - conv.resolvedAt.getTime();
      if (ageMs > hours * 3_600_000) {
        throw new DomainError(
          "REOPEN_WINDOW_EXPIRED",
          `Reopen window expired — resolved tickets close after ${hours}h; open a follow-up instead`,
        );
      }
    }
    const active = await findActiveTicket(tx, conv.channelConnectionId, conv.externalId);
    if (active) {
      throw new DomainError(
        "ACTIVE_TICKET_EXISTS",
        "This chat already has an active follow-up ticket — work that one instead",
      );
    }
    try {
      return await patchTicket(tx, ctx.organizationId, {
        conversationId,
        patch: {
          status: conv.assigneeId ? "in_progress" : "open",
          resolvedAt: null,
          resolvedById: null,
        },
      });
    } catch (error) {
      // A concurrent inbound may have committed a follow-up between the
      // check above and this update — the partial unique index still blocks
      // two active tickets; surface it as the same domain error.
      if (isUniqueViolation(error, "conversations_connection_external_idx")) {
        throw new DomainError(
          "ACTIVE_TICKET_EXISTS",
          "This chat already has an active follow-up ticket — work that one instead",
        );
      }
      throw error;
    }
  });
}

/**
 * Requires messaging:write. Defers a ticket out of every work view until
 * `until` passes (lazy un-snooze — the views compare against now()); `null`
 * resumes it immediately. Status/assignee are untouched — snooze is
 * orthogonal to the ticket lifecycle.
 */
export async function setConversationSnooze(
  db: Database,
  ctx: TenantContext,
  input: SnoozeConversationInput,
): Promise<ConversationRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const parsed = snoozeConversationInput.parse(input);
  if (parsed.until !== null && parsed.until.getTime() <= Date.now()) {
    throw new DomainError("SNOOZE_IN_PAST", "Snooze target must be in the future");
  }
  return withTenant(db, ctx.organizationId, async (tx) => {
    const conv = await loadActiveTicket(tx, parsed.conversationId);
    assertTicketOwner(conv, ctx);
    return patchTicket(tx, ctx.organizationId, {
      conversationId: parsed.conversationId,
      patch: {
        snoozedUntil: parsed.until,
      },
    });
  });
}

/** Requires messaging:write. Agent replied / stepped away — waiting on the customer. */
export async function setConversationWaiting(
  db: Database,
  ctx: TenantContext,
  input: ConversationIdInput,
): Promise<ConversationRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const { conversationId } = conversationIdInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    const conv = await loadActiveTicket(tx, conversationId);
    assertTicketOwner(conv, ctx);
    return patchTicket(tx, ctx.organizationId, {
      conversationId,
      patch: { status: "waiting_customer" },
    });
  });
}

/** Requires messaging:write. Moves a waiting/queued ticket back to in_progress. */
export async function setConversationInProgress(
  db: Database,
  ctx: TenantContext,
  input: ConversationIdInput,
): Promise<ConversationRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const { conversationId } = conversationIdInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    const conv = await loadActiveTicket(tx, conversationId);
    assertTicketOwner(conv, ctx);
    return patchTicket(tx, ctx.organizationId, {
      conversationId,
      patch: { status: "in_progress" },
    });
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
    const active = await findActiveTicket(tx, source.channelConnectionId, source.externalId);
    if (active) {
      throw new DomainError(
        "ACTIVE_TICKET_EXISTS",
        "This chat already has an active follow-up ticket — work that one instead",
      );
    }
    let ticket: ConversationRow;
    try {
      ticket = await createFollowupTicket(
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
      );
    } catch (error) {
      // Same race as reopenTicket — an inbound may have committed a
      // follow-up between the check above and this insert.
      if (isUniqueViolation(error, "conversations_connection_external_idx")) {
        throw new DomainError(
          "ACTIVE_TICKET_EXISTS",
          "This chat already has an active follow-up ticket — work that one instead",
        );
      }
      throw error;
    }
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
