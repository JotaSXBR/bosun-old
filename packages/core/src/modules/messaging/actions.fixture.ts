// Shared setup for the ticket-actions integration tests (not a test file itself).
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll } from "vitest";

import type { TenantContext } from "../../tenant/context";
import type { ConnectionRef } from "./service";
import { ingestChannelEvent } from "./service";

const { channelConnections, conversations, organizationMembers, organizations, users } = schema;

type State = {
  db: Database;
  orgA: string;
  userId: string;
  agent2: string;
  outsider: string;
  connA: ConnectionRef;
};

async function assertMigrated(db: Database): Promise<void> {
  try {
    await db.execute(sql`select 1`);
  } catch (error) {
    throw new Error(
      "Integration tests require a migrated database. Run `pnpm infra:up && pnpm db:migrate` first.",
      { cause: error },
    );
  }
}

async function insertUsers(db: Database, suffix: string) {
  const inserted = await db
    .insert(users)
    .values([
      { name: "IT User", email: `it-act-${suffix}@crm.local` },
      { name: "IT Agent2", email: `it-act2-${suffix}@crm.local` },
      { name: "IT Outsider", email: `it-out-${suffix}@crm.local` },
    ])
    .returning({ id: users.id });
  return { userId: inserted[0]!.id, agent2: inserted[1]!.id, outsider: inserted[2]!.id };
}

async function insertConnection(db: Database, orgA: string, suffix: string) {
  return withTenant(db, orgA, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgA,
        kind: "waha",
        name: "IT WAHA",
        credentialsEncrypted: "not-used-in-these-tests",
        webhookToken: `tok-act-${suffix}`,
      })
      .returning();
    return { id: row!.id, organizationId: orgA, kind: row!.kind };
  });
}

async function setUp(): Promise<State> {
  const db = createDb(getServerEnv().database.url);
  await assertMigrated(db);

  const suffix = crypto.randomUUID().slice(0, 8);
  const { userId, agent2, outsider } = await insertUsers(db, suffix);
  const [org] = await db
    .insert(organizations)
    .values({ name: "Act IT A", slug: `act-a-${suffix}` })
    .returning({ id: organizations.id });
  const orgA = org!.id;
  await db.insert(organizationMembers).values([
    { organizationId: orgA, userId, role: "agent" },
    { organizationId: orgA, userId: agent2, role: "agent" },
  ]);
  const connA = await insertConnection(db, orgA, suffix);
  return { db, orgA, userId, agent2, outsider, connA };
}

async function tearDown({ db, orgA, userId, agent2, outsider }: State) {
  await db.delete(organizations).where(sql`${organizations.id} = ${orgA}`);
  await db.delete(users).where(sql`${users.id} in (${userId}, ${agent2}, ${outsider})`);
  await db.$client.end();
}

/** Ingests one inbound on connA/orgA and returns the resulting active ticket. */
async function newTicketIn(
  { db, orgA, connA }: State,
  input: {
    channelUserId: string;
    messageId: string;
    timestamp: Date;
  },
) {
  const { channelUserId, messageId, timestamp } = input;
  await withTenant(db, orgA, (tx) =>
    ingestChannelEvent(tx, connA, {
      event: {
        type: "message.received",
        externalMessageId: messageId,
        from: { channelUserId, displayName: "Act" },
        content: { type: "text", text: "hi" },
        timestamp,
      },
    }),
  );
  return withTenant(db, orgA, async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.externalId, channelUserId),
          sql`${conversations.status} != 'resolved'`,
        ),
      );
    return conv!;
  });
}

/**
 * Registers the org/users/connection hooks and returns accessors plus the
 * helpers bound to them. Call once at the top of a test file.
 */
export function useActionsFixture() {
  let state: State;
  beforeAll(async () => {
    state = await setUp();
  });
  afterAll(() => tearDown(state));

  return {
    db: () => state.db,
    orgA: () => state.orgA,
    userId: () => state.userId,
    agent2: () => state.agent2,
    outsider: () => state.outsider,
    connA: () => state.connA,
    ctx: (organizationId: string, role: TenantContext["role"]): TenantContext => ({
      organizationId,
      userId: state.userId,
      role,
      isPlatformAdmin: false,
    }),
    newTicket: (channelUserId: string, messageId: string, timestamp: Date) =>
      newTicketIn(state, { channelUserId, messageId, timestamp }),
  };
}
