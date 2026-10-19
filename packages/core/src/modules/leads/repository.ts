import type { DbExecutor } from "@crm/db";
import { schema } from "@crm/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

const { contacts, conversations, dealLabels, deals, funnelStages, funnels, labels } = schema;

export type StageRow = typeof funnelStages.$inferSelect;
export type DealRow = typeof deals.$inferSelect;
export type LabelRow = typeof labels.$inferSelect;

export type DealCardRow = DealRow & {
  contactName: string | null;
  contactRef: string;
  labels: LabelRow[];
};

export * from "./repository-funnels";

// ---------- stages ----------

export async function listStages(executor: DbExecutor, organizationId: string, funnelId: string) {
  return executor
    .select()
    .from(funnelStages)
    .where(
      and(eq(funnelStages.funnelId, funnelId), eq(funnelStages.organizationId, organizationId)),
    )
    .orderBy(asc(funnelStages.position));
}

/** Ordered stages across several funnels — batched replacement for per-funnel listStages. */
export async function listStagesByFunnels(
  executor: DbExecutor,
  organizationId: string,
  funnelIds: string[],
) {
  if (funnelIds.length === 0) return [];
  return executor
    .select()
    .from(funnelStages)
    .where(
      and(
        eq(funnelStages.organizationId, organizationId),
        inArray(funnelStages.funnelId, funnelIds),
      ),
    )
    .orderBy(asc(funnelStages.position));
}

export async function findStageById(executor: DbExecutor, organizationId: string, stageId: string) {
  const [row] = await executor
    .select()
    .from(funnelStages)
    .where(and(eq(funnelStages.id, stageId), eq(funnelStages.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

export async function insertStage(
  executor: DbExecutor,
  values: {
    organizationId: string;
    funnelId: string;
    name: string;
    position: number;
    color: string;
  },
) {
  const [row] = await executor.insert(funnelStages).values(values).returning();
  if (!row) throw new Error("funnel_stages insert returned no row");
  return row;
}

export async function updateStage(
  executor: DbExecutor,
  stageId: string,
  values: { name?: string; color?: string; position?: number },
) {
  const [row] = await executor
    .update(funnelStages)
    .set(values)
    .where(eq(funnelStages.id, stageId))
    .returning();
  return row;
}

export async function deleteStage(executor: DbExecutor, stageId: string) {
  const rows = await executor
    .delete(funnelStages)
    .where(eq(funnelStages.id, stageId))
    .returning({ id: funnelStages.id });
  return rows.length > 0;
}

// ---------- deals ----------

export async function listBoardDeals(
  executor: DbExecutor,
  organizationId: string,
  funnelId: string,
): Promise<DealCardRow[]> {
  const rows = await executor
    .select({
      deal: deals,
      contactName: contacts.displayName,
      contactRef: contacts.channelUserId,
      label: labels,
    })
    .from(deals)
    .innerJoin(contacts, eq(deals.contactId, contacts.id))
    .leftJoin(dealLabels, eq(dealLabels.dealId, deals.id))
    .leftJoin(labels, eq(dealLabels.labelId, labels.id))
    .where(and(eq(deals.organizationId, organizationId), eq(deals.funnelId, funnelId)))
    .orderBy(asc(deals.stageId), asc(deals.position), asc(deals.createdAt));

  const byId = new Map<string, DealCardRow>();
  for (const row of rows) {
    let card = byId.get(row.deal.id);
    if (!card) {
      card = {
        ...row.deal,
        contactName: row.contactName,
        contactRef: row.contactRef,
        labels: [],
      };
      byId.set(row.deal.id, card);
    }
    if (row.label) card.labels.push(row.label);
  }
  return [...byId.values()];
}

export async function findDealById(executor: DbExecutor, organizationId: string, dealId: string) {
  const [row] = await executor
    .select()
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

export async function findDealByConversation(
  executor: DbExecutor,
  organizationId: string,
  conversationId: string,
): Promise<(DealRow & { stageName: string; funnelName: string }) | null> {
  const [row] = await executor
    .select({ deal: deals, stageName: funnelStages.name, funnelName: funnels.name })
    .from(deals)
    .innerJoin(funnelStages, eq(deals.stageId, funnelStages.id))
    .innerJoin(funnels, eq(deals.funnelId, funnels.id))
    .where(and(eq(deals.organizationId, organizationId), eq(deals.conversationId, conversationId)))
    .limit(1);
  return row ? { ...row.deal, stageName: row.stageName, funnelName: row.funnelName } : null;
}

export async function findConversationContact(
  executor: DbExecutor,
  organizationId: string,
  conversationId: string,
) {
  const [row] = await executor
    .select({
      conversationId: conversations.id,
      contactId: conversations.contactId,
      contactName: contacts.displayName,
      contactRef: contacts.channelUserId,
    })
    .from(conversations)
    .innerJoin(contacts, eq(conversations.contactId, contacts.id))
    .where(
      and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId)),
    )
    .limit(1);
  return row ?? null;
}

export async function findContactById(
  executor: DbExecutor,
  organizationId: string,
  contactId: string,
) {
  const [row] = await executor
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

/** Contact picker rows for the "new deal" dialog. */
export async function searchContacts(
  executor: DbExecutor,
  organizationId: string,
  { query, limit }: { query: string | undefined; limit: number },
) {
  const pattern = `%${(query ?? "").replace(/[%_\\]/g, "")}%`;
  return executor
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      channelUserId: contacts.channelUserId,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, organizationId),
        query
          ? sql`(${contacts.displayName} ilike ${pattern} or ${contacts.channelUserId} ilike ${pattern})`
          : undefined,
      ),
    )
    .orderBy(asc(contacts.displayName), asc(contacts.channelUserId))
    .limit(limit);
}

export async function insertDeal(
  executor: DbExecutor,
  values: {
    organizationId: string;
    funnelId: string;
    stageId: string;
    contactId: string;
    conversationId?: string | undefined;
    title: string;
    valueCents: number;
    position: number;
    customAttributes: Record<string, unknown>;
  },
) {
  const [row] = await executor.insert(deals).values(values).returning();
  if (!row) throw new Error("deals insert returned no row");
  return row;
}

export async function updateDeal(
  executor: DbExecutor,
  dealId: string,
  values: {
    title?: string;
    valueCents?: number;
    customAttributes?: Record<string, unknown>;
    stageId?: string;
    position?: number;
  },
) {
  const [row] = await executor
    .update(deals)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(deals.id, dealId))
    .returning();
  return row;
}

export async function deleteDeal(executor: DbExecutor, dealId: string) {
  const rows = await executor.delete(deals).where(eq(deals.id, dealId)).returning({ id: deals.id });
  return rows.length > 0;
}

/** Deal ids in a stage ordered by current position — used to renormalize. */
export async function listDealIdsInStage(executor: DbExecutor, stageId: string): Promise<string[]> {
  const rows = await executor
    .select({ id: deals.id })
    .from(deals)
    .where(eq(deals.stageId, stageId))
    .orderBy(asc(deals.position), asc(deals.createdAt));
  return rows.map((r) => r.id);
}

export async function setDealPosition(executor: DbExecutor, dealId: string, position: number) {
  await executor.update(deals).set({ position }).where(eq(deals.id, dealId));
}

export async function nextDealPosition(executor: DbExecutor, stageId: string): Promise<number> {
  const [row] = await executor
    .select({ max: sql<number | null>`max(${deals.position})` })
    .from(deals)
    .where(eq(deals.stageId, stageId));
  return (row?.max ?? -1) + 1;
}

export async function countDealsInStage(executor: DbExecutor, stageId: string): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(deals)
    .where(eq(deals.stageId, stageId));
  return row?.count ?? 0;
}
