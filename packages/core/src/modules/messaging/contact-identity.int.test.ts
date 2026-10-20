// Integration test — a WhatsApp sender that arrives as @lid is identified by its phone.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import type { ChannelEvent } from "@crm/channels";
import { getServerEnv } from "@crm/config";
import type { Database, DomainEvent } from "@crm/db";
import { createDb, schema, subscribeDomainEvents, withTenant } from "@crm/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConnectionRef } from "./service";
import { ingestChannelEvent } from "./service";

const { channelConnections, contacts, conversations, organizations } = schema;

const PHONE = "5516997524950@c.us";
const LID = "16449842241553@lid";

let db: Database;
let orgId: string;
let conn: ConnectionRef;

const received = (
  id: string,
  from: { channelUserId: string; lid?: string; displayName?: string },
) =>
  ({
    type: "message.received",
    externalMessageId: id,
    from,
    content: { type: "text", text: "oi" },
    timestamp: new Date("2026-10-20T15:00:00Z"),
  }) satisfies ChannelEvent;

const ingest = (event: ChannelEvent) =>
  withTenant(db, orgId, (tx) => ingestChannelEvent(tx, conn, { event }));

const contactsOf = () => withTenant(db, orgId, (tx) => tx.select().from(contacts));
const ticketsOf = () => withTenant(db, orgId, (tx) => tx.select().from(conversations));

beforeAll(async () => {
  db = createDb(getServerEnv().database.url);
  const suffix = crypto.randomUUID().slice(0, 8);
  const [org] = await db
    .insert(organizations)
    .values({ name: "Identity IT", slug: `identity-${suffix}` })
    .returning({ id: organizations.id });
  orgId = org!.id;
  conn = await withTenant(db, orgId, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgId,
        kind: "waha",
        name: "IT identity",
        credentialsEncrypted: "not-used",
        webhookToken: `tok-identity-${suffix}`,
      })
      .returning();
    return { id: row!.id, organizationId: orgId, kind: row!.kind };
  });
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.$client.end();
});

describe("contact identity by phone", () => {
  it("keys the contact and the ticket by the phone and keeps the lid as alias", async () => {
    await ingest(
      received("id_1", { channelUserId: PHONE, lid: LID, displayName: "Jessé @ Fluxie" }),
    );
    const [contact] = await contactsOf();
    expect(contact).toMatchObject({
      channelUserId: PHONE,
      displayName: "Jessé @ Fluxie",
      metadata: { lid: LID },
    });
    const [ticket] = await ticketsOf();
    expect(ticket?.externalId).toBe(PHONE);
  });

  it("reuses the same contact and ticket on a later message and never renames it", async () => {
    await withTenant(db, orgId, (tx) =>
      tx
        .update(contacts)
        .set({ displayName: "Jessé (Fluxie)" })
        .where(eq(contacts.channelUserId, PHONE)),
    );
    await ingest(received("id_2", { channelUserId: PHONE, lid: LID, displayName: "Outra Pessoa" }));
    const all = await contactsOf();
    expect(all).toHaveLength(1);
    expect(all[0]?.displayName).toBe("Jessé (Fluxie)");
    expect(await ticketsOf()).toHaveLength(1);
  });

  it("delivers presence sent to the lid chat to the phone's ticket", async () => {
    const events: DomainEvent[] = [];
    const unsubscribe = await subscribeDomainEvents(orgId, (event) => events.push(event));
    try {
      await ingest({
        type: "contact.presence",
        chatId: LID,
        participant: null,
        presence: "typing",
      });
      const deadline = Date.now() + 5000;
      while (!events.some((e) => e.type === "contact.presence") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await unsubscribe();
    }
    const [ticket] = await ticketsOf();
    expect(events.find((e) => e.type === "contact.presence")).toMatchObject({
      conversationId: ticket?.id,
    });
  });

  it("keeps an unresolved sender provisional under its lid", async () => {
    await ingest(received("id_3", { channelUserId: "999@lid", displayName: "Sem telefone" }));
    const lidContact = (await contactsOf()).find((c) => c.channelUserId === "999@lid");
    expect(lidContact?.metadata).toEqual({});
  });
});

describe("lid alias uniqueness", () => {
  it("refuses a second contact with the same lid in an organization but not in another", async () => {
    const other = await db
      .insert(organizations)
      .values({ name: "Identity IT 2", slug: `identity2-${crypto.randomUUID().slice(0, 8)}` })
      .returning({ id: organizations.id });
    const otherId = other[0]!.id;
    try {
      const insert = (organizationId: string, channelUserId: string) =>
        withTenant(db, organizationId, (tx) =>
          tx.insert(contacts).values({
            organizationId,
            channelUserId,
            metadata: { lid: "777@lid" },
          }),
        );
      await insert(orgId, "5511911111111@c.us");
      await expect(insert(orgId, "5511922222222@c.us")).rejects.toThrow();
      await expect(insert(otherId, "5511911111111@c.us")).resolves.toBeDefined();
    } finally {
      await db.delete(organizations).where(eq(organizations.id, otherId));
    }
  });
});
