import type { Database } from "@crm/db";
import { withTenant } from "@crm/db";

import { DomainError, NotFoundError } from "../../errors";
import { isUniqueViolation } from "../../lib/pg-error";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import type { DealRow } from "./repository";
import * as repo from "./repository";
import type {
  CreateDealFromConversationInput,
  CreateDealInput,
  MoveDealInput,
  UpdateDealInput,
} from "./schemas";
import {
  createDealFromConversationInput,
  createDealInput,
  moveDealInput,
  updateDealInput,
} from "./schemas";
import { audit } from "./shared";

// ---------- deals ----------

/** Requires leads:write. */
export async function createDeal(
  db: Database,
  ctx: TenantContext,
  input: CreateDealInput,
): Promise<DealRow> {
  assertPermission(ctx, { leads: ["write"] });
  const parsed = createDealInput.parse(input);
  const deal = await withTenant(db, ctx.organizationId, async (tx) => {
    const stage = await repo.findStageById(tx, ctx.organizationId, parsed.stageId);
    if (stage?.funnelId !== parsed.funnelId) {
      throw new NotFoundError("Stage", parsed.stageId);
    }
    const contact = await repo.findContactById(tx, ctx.organizationId, parsed.contactId);
    if (!contact) throw new NotFoundError("Contact", parsed.contactId);
    return repo.insertDeal(tx, {
      organizationId: ctx.organizationId,
      funnelId: parsed.funnelId,
      stageId: parsed.stageId,
      contactId: parsed.contactId,
      title: parsed.title,
      valueCents: parsed.valueCents ?? 0,
      position: await repo.nextDealPosition(tx, parsed.stageId),
      customAttributes: parsed.customAttributes ?? {},
    });
  });
  audit(db, ctx, { action: "deal.created", id: deal.id });
  return deal;
}

/**
 * Requires leads:write. Converts a conversation into a deal: the contact is
 * taken from the conversation and `conversation_id` links them (unique —
 * a second attempt raises CONVERSATION_ALREADY_LINKED).
 */
export async function createDealFromConversation(
  db: Database,
  ctx: TenantContext,
  input: CreateDealFromConversationInput,
): Promise<DealRow> {
  assertPermission(ctx, { leads: ["write"] });
  const parsed = createDealFromConversationInput.parse(input);
  let deal: DealRow;
  try {
    deal = await withTenant(db, ctx.organizationId, async (tx) => {
      const conversation = await repo.findConversationContact(
        tx,
        ctx.organizationId,
        parsed.conversationId,
      );
      if (!conversation) throw new NotFoundError("Conversation", parsed.conversationId);
      const stage = await repo.findStageById(tx, ctx.organizationId, parsed.stageId);
      if (stage?.funnelId !== parsed.funnelId) {
        throw new NotFoundError("Stage", parsed.stageId);
      }
      return repo.insertDeal(tx, {
        organizationId: ctx.organizationId,
        funnelId: parsed.funnelId,
        stageId: parsed.stageId,
        contactId: conversation.contactId,
        conversationId: conversation.conversationId,
        title: parsed.title ?? conversation.contactName ?? conversation.contactRef,
        valueCents: parsed.valueCents ?? 0,
        position: await repo.nextDealPosition(tx, parsed.stageId),
        customAttributes: {},
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, "deals_conversation_unique")) {
      throw new DomainError(
        "CONVERSATION_ALREADY_LINKED",
        "This conversation is already linked to a deal",
      );
    }
    throw error;
  }
  audit(db, ctx, { action: "deal.created_from_conversation", id: deal.id });
  return deal;
}

/** Requires leads:write. */
export async function updateDeal(
  db: Database,
  ctx: TenantContext,
  input: UpdateDealInput,
): Promise<DealRow> {
  assertPermission(ctx, { leads: ["write"] });
  const parsed = updateDealInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    const row = await repo.updateDeal(tx, parsed.dealId, {
      title: parsed.title,
      valueCents: parsed.valueCents,
      customAttributes: parsed.customAttributes,
    });
    if (!row) throw new NotFoundError("Deal", parsed.dealId);
    return row;
  });
}

/**
 * Requires leads:write. Moves a card to `stageId` at `position` (clamped),
 * then renumbers both affected stages 0..n.
 */
export async function moveDeal(
  db: Database,
  ctx: TenantContext,
  input: MoveDealInput,
): Promise<DealRow> {
  assertPermission(ctx, { leads: ["write"] });
  const parsed = moveDealInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    const deal = await repo.findDealById(tx, ctx.organizationId, parsed.dealId);
    if (!deal) throw new NotFoundError("Deal", parsed.dealId);
    const stage = await repo.findStageById(tx, ctx.organizationId, parsed.stageId);
    if (stage?.funnelId !== deal.funnelId) {
      throw new NotFoundError("Stage", parsed.stageId);
    }
    const sourceStageId = deal.stageId;
    const targetIds = (await repo.listDealIdsInStage(tx, parsed.stageId)).filter(
      (id) => id !== deal.id,
    );
    const position = Math.min(parsed.position, targetIds.length);
    targetIds.splice(position, 0, deal.id);
    await repo.updateDeal(tx, deal.id, { stageId: parsed.stageId, position });
    for (const [index, dealId] of targetIds.entries()) {
      if (dealId !== deal.id) await repo.setDealPosition(tx, dealId, index);
    }
    if (sourceStageId !== parsed.stageId) {
      const remaining = await repo.listDealIdsInStage(tx, sourceStageId);
      for (const [index, dealId] of remaining.entries()) {
        await repo.setDealPosition(tx, dealId, index);
      }
    }
    const updated = await repo.findDealById(tx, ctx.organizationId, deal.id);
    return updated ?? deal;
  });
}

/** Requires leads:manage (destructive). */
export async function deleteDeal(db: Database, ctx: TenantContext, dealId: string): Promise<void> {
  assertPermission(ctx, { leads: ["manage"] });
  await withTenant(db, ctx.organizationId, async (tx) => {
    if (!(await repo.deleteDeal(tx, dealId))) throw new NotFoundError("Deal", dealId);
  });
  audit(db, ctx, { action: "deal.deleted", id: dealId });
}

/** Deal linked to a conversation, if any. Requires leads:read. */
export async function getDealForConversation(
  db: Database,
  ctx: TenantContext,
  conversationId: string,
) {
  assertPermission(ctx, { leads: ["read"] });
  return withTenant(db, ctx.organizationId, (tx) =>
    repo.findDealByConversation(tx, ctx.organizationId, conversationId),
  );
}

/** Contact picker for "new deal". Requires leads:read. */
export async function searchContacts(
  db: Database,
  ctx: TenantContext,
  { query, limit = 20 }: { query?: string; limit?: number } = {},
) {
  assertPermission(ctx, { leads: ["read"] });
  return withTenant(db, ctx.organizationId, (tx) =>
    repo.searchContacts(tx, ctx.organizationId, { query, limit }),
  );
}
