// Integration test — the provisional @lid contact is folded into the phone contact.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import type { ChannelEvent } from "@crm/channels";
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConnectionRef } from "./service";
import { ingestChannelEvent } from "./service";

const {
  channelConnections,
  contactLabels,
  conversationLabels,
  conversationReads,
  contacts,
  conversations,
  deals,
  funnels,
  funnelStages,
  labels,
  memoryEntries,
  messages,
  organizations,
  users,
} = schema;

const PHONE = "5516997524950@c.us";
const LID = "16449842241553@lid";

type Org = { id: string; conn: ConnectionRef };
let db: Database;
let a: Org;
let b: Org;

const received = (
  id: string,
  from: { channelUserId: string; lid?: string; displayName?: string },
): ChannelEvent => ({
  type: "message.received",
  externalMessageId: id,
  from,
  content: { type: "text", text: id },
  timestamp: new Date("2026-10-20T15:00:00Z"),
});

const ingest = (org: Org, event: ChannelEvent) =>
  withTenant(db, org.id, (tx) => ingestChannelEvent(tx, org.conn, { event }));

async function createOrg(label: string): Promise<Org> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [org] = await db
    .insert(organizations)
    .values({ name: `Merge ${label}`, slug: `merge-${label}-${suffix}` })
    .returning({ id: organizations.id });
  const conn = await withTenant(db, org!.id, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: org!.id,
        kind: "waha",
        name: `IT merge ${label}`,
        credentialsEncrypted: "not-used",
        webhookToken: `tok-merge-${label}-${suffix}`,
      })
      .returning();
    return { id: row!.id, organizationId: org!.id, kind: row!.kind };
  });
  return { id: org!.id, conn };
}

const contactsOf = (org: Org) => withTenant(db, org.id, (tx) => tx.select().from(contacts));
const ticketsOf = (org: Org) => withTenant(db, org.id, (tx) => tx.select().from(conversations));
const messagesOf = (org: Org) => withTenant(db, org.id, (tx) => tx.select().from(messages));

beforeAll(async () => {
  db = createDb(getServerEnv().database.url);
  a = await createOrg("a");
  b = await createOrg("b");
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, a.id));
  await db.delete(organizations).where(eq(organizations.id, b.id));
  await db.$client.end();
});

describe("mergeLidContact", () => {
  it("moves the lid contact's ticket, messages, deal, label and memory to the phone contact", async () => {
    await ingest(a, received("lid_1", { channelUserId: LID, displayName: "Provisório" }));
    const [lost] = await contactsOf(a);
    const [ticket] = await ticketsOf(a);
    await withTenant(db, a.id, async (tx) => {
      const [funnel] = await tx
        .insert(funnels)
        .values({ organizationId: a.id, name: "F" })
        .returning();
      const [stage] = await tx
        .insert(funnelStages)
        .values({ organizationId: a.id, funnelId: funnel!.id, name: "S", position: 0 })
        .returning();
      await tx.insert(deals).values({
        organizationId: a.id,
        funnelId: funnel!.id,
        stageId: stage!.id,
        contactId: lost!.id,
        title: "Deal",
        position: 0,
      });
      const [label] = await tx
        .insert(labels)
        .values({ organizationId: a.id, name: "VIP" })
        .returning();
      await tx
        .insert(contactLabels)
        .values({ organizationId: a.id, contactId: lost!.id, labelId: label!.id });
      await tx.insert(memoryEntries).values({
        organizationId: a.id,
        type: "note",
        contactId: lost!.id,
        content: "prefere áudio",
        staleAfter: new Date("2027-01-01T00:00:00Z"),
      });
    });

    await ingest(a, received("phone_1", { channelUserId: PHONE, lid: LID }));

    const all = await contactsOf(a);
    expect(all).toHaveLength(1);
    const survivor = all[0]!;
    expect(survivor).toMatchObject({ channelUserId: PHONE, displayName: "Provisório" });
    expect(await ticketsOf(a)).toMatchObject([
      { id: ticket!.id, externalId: PHONE, contactId: survivor.id },
    ]);
    expect((await messagesOf(a)).map((m) => m.contactId)).toEqual([survivor.id, survivor.id]);
    await withTenant(db, a.id, async (tx) => {
      expect((await tx.select().from(deals))[0]?.contactId).toBe(survivor.id);
      expect((await tx.select().from(contactLabels))[0]?.contactId).toBe(survivor.id);
      expect((await tx.select().from(memoryEntries))[0]?.contactId).toBe(survivor.id);
    });
  });

  it("is idempotent: another message changes nothing structural", async () => {
    await ingest(a, received("phone_2", { channelUserId: PHONE, lid: LID }));
    expect(await contactsOf(a)).toHaveLength(1);
    expect(await ticketsOf(a)).toHaveLength(1);
    expect(await messagesOf(a)).toHaveLength(3);
  });

  it("folds two active tickets into the phone's and keeps every message", async () => {
    const other = "5511988887777@c.us";
    const otherLid = "55555555@lid";
    await ingest(a, received("o_phone", { channelUserId: other }));
    await ingest(a, received("o_lid", { channelUserId: otherLid }));
    expect(await ticketsOf(a)).toHaveLength(3);

    await ingest(a, received("o_both", { channelUserId: other, lid: otherLid }));

    const tickets = (await ticketsOf(a)).filter((t) => t.externalId === other);
    expect(tickets).toHaveLength(1);
    const folded = (await messagesOf(a)).filter((m) => m.conversationId === tickets[0]!.id);
    expect(folded.map((m) => m.externalId).sort()).toEqual(["o_both", "o_lid", "o_phone"]);
    expect((await contactsOf(a)).some((c) => c.channelUserId === otherLid)).toBe(false);
  });

  it("never touches a contact with the same lid in another organization", async () => {
    await ingest(b, received("b_lid", { channelUserId: LID, displayName: "De outra org" }));
    await ingest(a, received("a_again", { channelUserId: PHONE, lid: LID }));
    const [bContact] = await contactsOf(b);
    expect(bContact).toMatchObject({ channelUserId: LID, displayName: "De outra org" });
    expect(await ticketsOf(b)).toHaveLength(1);
  });
});

describe("folding two active tickets", () => {
  it("keeps labels, read cursors and links, and survives duplicate auto-reply markers", async () => {
    const phone = "5511977776666@c.us";
    const lid = "31313@lid";
    await ingest(a, received("f_phone", { channelUserId: phone }));
    await ingest(a, received("f_lid", { channelUserId: lid }));
    const tickets = await ticketsOf(a);
    const twin = tickets.find((t) => t.externalId === phone)!;
    const lost = tickets.find((t) => t.externalId === lid)!;
    const suffix = crypto.randomUUID().slice(0, 8);

    await withTenant(db, a.id, async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ name: "Fold", email: `fold-${suffix}@crm.local` })
        .returning({ id: users.id });
      for (const conversationId of [twin.id, lost.id]) {
        await tx.insert(messages).values({
          organizationId: a.id,
          conversationId,
          channelConnectionId: a.conn.id,
          direction: "outbound",
          content: { type: "text", text: "nota" },
          status: "sent",
          metadata: { system: "unsupported_media" },
        });
      }
      const [label] = await tx
        .insert(labels)
        .values({ organizationId: a.id, name: "Fold" })
        .returning();
      await tx
        .insert(conversationLabels)
        .values({ organizationId: a.id, conversationId: lost.id, labelId: label!.id });
      await tx.insert(conversationReads).values([
        {
          organizationId: a.id,
          conversationId: twin.id,
          userId: user!.id,
          lastReadAt: new Date("2026-10-01"),
        },
        {
          organizationId: a.id,
          conversationId: lost.id,
          userId: user!.id,
          lastReadAt: new Date("2026-10-10"),
        },
      ]);
      await tx
        .update(conversations)
        .set({ precededById: lost.id })
        .where(eq(conversations.id, twin.id));
    });

    await ingest(a, received("f_both", { channelUserId: phone, lid }));

    await withTenant(db, a.id, async (tx) => {
      expect((await tx.select().from(conversationLabels)).map((r) => r.conversationId)).toEqual([
        twin.id,
      ]);
      const reads = await tx.select().from(conversationReads);
      expect(reads).toHaveLength(1);
      expect(reads[0]?.lastReadAt.toISOString()).toBe("2026-10-10T00:00:00.000Z");
      const markers = (await tx.select().from(messages)).filter(
        (m) =>
          m.conversationId === twin.id &&
          (m.metadata as { system?: string }).system === "unsupported_media",
      );
      expect(markers).toHaveLength(1);
      expect(
        (await tx.select().from(conversations).where(eq(conversations.id, twin.id)))[0]
          ?.precededById,
      ).toBeNull();
    });
  });
});

describe("concurrent webhooks", () => {
  it("converges to one contact and one ticket when two messages race on the same lid", async () => {
    const phone = "5511966665555@c.us";
    const lid = "62626@lid";
    const results = await Promise.allSettled([
      ingest(a, received("r_1", { channelUserId: phone, lid })),
      ingest(a, received("r_2", { channelUserId: phone, lid })),
      ingest(a, received("r_3", { channelUserId: lid })),
    ]);
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);

    await ingest(a, received("r_4", { channelUserId: phone, lid }));
    expect((await contactsOf(a)).filter((c) => c.channelUserId === lid)).toHaveLength(0);
    const tickets = (await ticketsOf(a)).filter((t) => t.externalId === phone);
    expect(tickets).toHaveLength(1);
    const ids = (await messagesOf(a))
      .filter((m) => m.conversationId === tickets[0]!.id)
      .map((m) => m.externalId);
    expect(ids.sort()).toEqual(["r_1", "r_2", "r_3", "r_4"]);
  });
});
