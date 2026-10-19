// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import type { ChannelEvent } from "@crm/channels";
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TenantContext } from "../../tenant/context";
import type { ConnectionRef } from "./service";
import { getConversationDetail, ingestChannelEvent, listTenantConversations } from "./service";

const { channelConnections, conversations, organizations, teams, users } = schema;

let db: Database;
let orgA: string;
let orgB: string;
let userId: string;
let connA: ConnectionRef;

function ctx(organizationId: string, role: TenantContext["role"]): TenantContext {
  return { organizationId, userId, role, isPlatformAdmin: false };
}

async function insertConnection(
  organizationId: string,
  webhookToken: string,
): Promise<ConnectionRef> {
  return withTenant(db, organizationId, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId,
        kind: "waha",
        name: "IT WAHA",
        credentialsEncrypted: "not-used-in-these-tests",
        webhookToken,
      })
      .returning();
    return { id: row!.id, organizationId, kind: row!.kind };
  });
}

beforeAll(async () => {
  const env = getServerEnv();
  db = createDb(env.database.url);
  try {
    await db.execute(sql`select 1`);
  } catch (error) {
    throw new Error(
      "Integration tests require a migrated database. Run `pnpm infra:up && pnpm db:migrate` first.",
      { cause: error },
    );
  }

  const suffix = crypto.randomUUID().slice(0, 8);
  const [user] = await db
    .insert(users)
    .values({ name: "IT User", email: `it-msg-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  const orgs = await db
    .insert(organizations)
    .values([
      { name: "Msg IT A", slug: `msg-a-${suffix}` },
      { name: "Msg IT B", slug: `msg-b-${suffix}` },
    ])
    .returning({ id: organizations.id });
  orgA = orgs[0]!.id;
  orgB = orgs[1]!.id;
  connA = await insertConnection(orgA, `tok-a-${suffix}`);
});

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.delete(users).where(sql`${users.id} = ${userId}`);
  await db.$client.end();
});

describe("conversation lifecycle", () => {
  it("replays on a resolved chat create no phantom ticket", async () => {
    const event: ChannelEvent = {
      type: "message.received",
      externalMessageId: "false_lc@c.us_REPLAY",
      from: { channelUserId: "lc-replay@c.us", displayName: "Replay" },
      content: { type: "text", text: "hi" },
      timestamp: new Date("2024-02-01T00:00:00Z"),
    };
    await withTenant(db, orgA, (tx) => ingestChannelEvent(tx, connA, { event }));

    // Agent resolves the ticket — then the provider retries the same
    // webhook: dedup must keep it resolved AND must not leave an empty
    // follow-up ticket behind.
    await withTenant(db, orgA, (tx) =>
      tx
        .update(conversations)
        .set({ status: "resolved", assigneeId: userId })
        .where(eq(conversations.externalId, "lc-replay@c.us")),
    );
    await withTenant(db, orgA, (tx) => ingestChannelEvent(tx, connA, { event }));

    await withTenant(db, orgA, async (tx) => {
      const rows = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.externalId, "lc-replay@c.us"));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("resolved");
      expect(rows[0]!.assigneeId).toBe(userId);
    });
  });

  it("inbound on resolved creates a NEW linked ticket — fresh queue", async () => {
    let teamId!: string;
    await withTenant(db, orgA, async (tx) => {
      const [team] = await tx
        .insert(teams)
        .values({ organizationId: orgA, name: `LC ${crypto.randomUUID().slice(0, 6)}` })
        .returning({ id: teams.id });
      teamId = team!.id;
    });

    const inbound: ChannelEvent = {
      type: "message.received",
      externalMessageId: "false_lc@c.us_A1",
      from: { channelUserId: "lc@c.us", displayName: "Life" },
      content: { type: "text", text: "first" },
      timestamp: new Date("2024-02-02T00:00:00Z"),
    };
    await withTenant(db, orgA, (tx) => ingestChannelEvent(tx, connA, { event: inbound }));
    let firstTicketId!: string;
    let firstTicketNumber!: number;
    await withTenant(db, orgA, async (tx) => {
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.externalId, "lc@c.us"));
      firstTicketId = conv!.id;
      firstTicketNumber = conv!.ticketNumber;
      expect(conv!.ticketSeq).toBe(1);
      expect(conv!.status).toBe("open");
      await tx
        .update(conversations)
        .set({ status: "resolved", assigneeId: userId, sectorId: teamId })
        .where(eq(conversations.id, firstTicketId));
    });

    // Customer replies on the resolved thread.
    await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          ...inbound,
          externalMessageId: "false_lc@c.us_A2",
          timestamp: new Date("2024-02-03T00:00:00Z"),
        },
      }),
    );

    await withTenant(db, orgA, async (tx) => {
      const rows = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.externalId, "lc@c.us"))
        .orderBy(conversations.createdAt);
      expect(rows).toHaveLength(2);
      // Closed ticket stays untouched history.
      expect(rows[0]!.status).toBe("resolved");
      expect(rows[0]!.assigneeId).toBe(userId);
      expect(rows[0]!.sectorId).toBe(teamId);
      // Follow-up ticket: open, fresh queue, linked to its predecessor.
      const follow = rows[1]!;
      expect(follow.status).toBe("open");
      expect(follow.assigneeId).toBeNull();
      expect(follow.sectorId).toBeNull();
      expect(follow.precededById).toBe(firstTicketId);
      expect(follow.ticketSeq).toBe(2);
      expect(follow.ticketNumber).toBe(firstTicketNumber + 1);
    });

    // The detail read surfaces the preceding ticket's numbers for the UI divider.
    const detail = await getConversationDetail(db, ctx(orgA, "agent"), {
      conversationId: (
        await listTenantConversations(db, ctx(orgA, "agent"), { view: "queue" })
      ).find((c) => c.precededById === firstTicketId)!.id,
    });
    expect(detail.precededTicketNumber).toBe(firstTicketNumber);
    expect(detail.precededTicketSeq).toBe(1);
  });

  it("inbound on waiting_customer returns to in_progress, keeping assignee", async () => {
    const inbound: ChannelEvent = {
      type: "message.received",
      externalMessageId: "false_wc@c.us_B1",
      from: { channelUserId: "wc@c.us", displayName: "Wait" },
      content: { type: "text", text: "ping" },
      timestamp: new Date("2024-02-04T00:00:00Z"),
    };
    await withTenant(db, orgA, (tx) => ingestChannelEvent(tx, connA, { event: inbound }));
    await withTenant(db, orgA, (tx) =>
      tx
        .update(conversations)
        .set({ status: "waiting_customer", assigneeId: userId })
        .where(eq(conversations.externalId, "wc@c.us")),
    );

    await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          ...inbound,
          externalMessageId: "false_wc@c.us_B2",
          timestamp: new Date("2024-02-05T00:00:00Z"),
        },
      }),
    );

    await withTenant(db, orgA, async (tx) => {
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.externalId, "wc@c.us"));
      expect(conv!.status).toBe("in_progress");
      expect(conv!.assigneeId).toBe(userId);
    });
  });
});
