// Demo conversations seed — tickets, messages and conversation labels.
import { schema } from "@crm/db";
import { and, eq, sql } from "drizzle-orm";

import { THREADS_FIRST, type ThreadSpec } from "./seed-data";
import { THREADS_LAST } from "./seed-data-threads";
import { type IdMap, type SeedDb, ts } from "./seed-shared";

const { contacts, conversations, messages, conversationLabels, ticketCounters } = schema;

export type ThreadCtx = {
  db: SeedDb;
  orgId: string;
  connId: Record<"waha" | "site", string>;
  contactMap: Map<string, { id: string; channelUserId: string }>;
  userIdByRole: IdMap;
  teamIdByName: IdMap;
  labelIdByName: IdMap;
  convIdBySuffix: Map<string, string>;
};

type ThreadIds = { connectionId: string; externalId: string; contactId: string };

async function nextTicketNumber(db: SeedDb, orgId: string): Promise<number> {
  const [counter] = await db
    .insert(ticketCounters)
    .values({ organizationId: orgId, value: 1 })
    .onConflictDoUpdate({
      target: ticketCounters.organizationId,
      set: { value: sql`${ticketCounters.value} + 1` },
    })
    .returning({ value: ticketCounters.value });
  if (!counter) throw new Error("failed to increment ticket counter");
  return counter.value;
}

async function bumpContactTicket(db: SeedDb, contactId: string): Promise<number> {
  const [row] = await db
    .update(contacts)
    .set({ ticketCounter: sql`${contacts.ticketCounter} + 1`, updatedAt: new Date() })
    .where(eq(contacts.id, contactId))
    .returning({ seq: contacts.ticketCounter });
  return row?.seq ?? 1;
}

async function insertThreadMessages(
  ctx: ThreadCtx,
  t: ThreadSpec,
  ids: { convId: string; contactId: string },
): Promise<void> {
  for (const [i, m] of t.msgs.entries()) {
    await ctx.db.insert(messages).values({
      organizationId: ctx.orgId,
      conversationId: ids.convId,
      channelConnectionId: ctx.connId[t.conn],
      contactId: m.dir === "inbound" ? ids.contactId : null,
      direction: m.dir,
      content: { type: "text", text: m.text },
      externalId: `seed-msg-${t.externalSuffix}-${i}`,
      private: m.private ?? false,
      authorId:
        m.dir === "outbound" || m.private
          ? (ctx.userIdByRole.get(m.authorRole ?? "agent") ?? null)
          : null,
      status: m.status ?? (m.dir === "inbound" ? "received" : "delivered"),
      sentAt: ts(m.daysAgo, m.hour ?? 10, i * 4),
    });
  }
  for (const labelName of t.labels ?? []) {
    const labelId = ctx.labelIdByName.get(labelName);
    if (labelId) {
      await ctx.db
        .insert(conversationLabels)
        .values({ organizationId: ctx.orgId, conversationId: ids.convId, labelId })
        .onConflictDoNothing();
    }
  }
}

async function insertConversationRow(
  ctx: ThreadCtx,
  t: ThreadSpec,
  ids: ThreadIds,
): Promise<string | null> {
  const lastMsg = t.msgs[t.msgs.length - 1]!;
  const lastChannelMsg = [...t.msgs].reverse().find((m) => !m.private) ?? lastMsg;
  const firstReply = t.msgs.find((m) => m.dir === "outbound");
  const resolved = t.status === "resolved" || t.status === "closed";

  const [conv] = await ctx.db
    .insert(conversations)
    .values({
      organizationId: ctx.orgId,
      channelConnectionId: ids.connectionId,
      contactId: ids.contactId,
      externalId: ids.externalId,
      status: t.status,
      sectorId: t.sector ? (ctx.teamIdByName.get(t.sector) ?? null) : null,
      assigneeId: t.assigneeRole ? (ctx.userIdByRole.get(t.assigneeRole) ?? null) : null,
      precededById: t.precededByKey ? (ctx.convIdBySuffix.get(t.precededByKey) ?? null) : null,
      ticketNumber: await nextTicketNumber(ctx.db, ctx.orgId),
      ticketSeq: await bumpContactTicket(ctx.db, ids.contactId),
      resolvedAt: resolved ? ts(3, 17) : null,
      resolvedById: resolved ? (ctx.userIdByRole.get(t.assigneeRole ?? "agent") ?? null) : null,
      snoozedUntil: t.snoozedUntil ?? null,
      firstResponseAt: firstReply ? ts(firstReply.daysAgo, firstReply.hour ?? 9) : null,
      lastMessageAt: ts(lastMsg.daysAgo, lastMsg.hour ?? 10),
      lastMessagePreview: lastChannelMsg.text.slice(0, 140),
      lastMessageDirection: lastChannelMsg.dir,
      createdAt: ts(t.msgs[0]!.daysAgo, t.msgs[0]!.hour ?? 10),
    })
    .returning({ id: conversations.id });
  return conv?.id ?? null;
}

async function findConversationId(
  ctx: ThreadCtx,
  connectionId: string,
  externalId: string,
): Promise<string | undefined> {
  const [existing] = await ctx.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.channelConnectionId, connectionId),
        eq(conversations.externalId, externalId),
      ),
    )
    .limit(1);
  return existing?.id;
}

async function ensureOneThread(ctx: ThreadCtx, t: ThreadSpec): Promise<void> {
  const contact = ctx.contactMap.get(t.contactKey);
  if (!contact) return;
  const ids: ThreadIds = {
    connectionId: ctx.connId[t.conn],
    externalId: `seed-conv-${t.externalSuffix}`,
    contactId: contact.id,
  };

  const existingId = await findConversationId(ctx, ids.connectionId, ids.externalId);
  const convId = existingId ?? (await insertConversationRow(ctx, t, ids));
  if (!convId) return;
  ctx.convIdBySuffix.set(t.externalSuffix, convId);
  if (!existingId) await insertThreadMessages(ctx, t, { convId, contactId: contact.id });
}

export async function ensureConversations(ctx: ThreadCtx): Promise<Map<string, string>> {
  for (const t of [...THREADS_FIRST, ...THREADS_LAST]) {
    await ensureOneThread(ctx, t);
  }
  return ctx.convIdBySuffix;
}
