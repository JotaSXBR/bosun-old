// Integration test — requires Postgres with migrations applied.
// Draft lifecycle: create → supersede → approve(send)/reject; drafts stay
// out of the settings suggestion inbox.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { FakeChannelProvider } from "@crm/channels/testing";
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError, NotFoundError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import type { ConnectionRef } from "../messaging";
import { addInternalNote, ingestChannelEvent, sendOutboundMessage } from "../messaging";
import { listAgentSuggestions } from "../suggestions";
import { listNudgeCandidates, listStaleNudges } from "./repository";
import {
  approveDraft,
  createDraftSuggestion,
  createNudgeSuggestion,
  findOrCreateDrafter,
  listThreadCards,
  rejectDraft,
  reviewNudge,
} from "./service";

const { channelConnections, conversations, organizationMembers, organizations, users } = schema;

let db: Database;
let orgA: string;
let orgB: string;
let userId: string;
let userB: string;
let adminId: string;
let connA: ConnectionRef;

const ctx = (organizationId: string, uid: string, role: TenantContext["role"]): TenantContext => ({
  organizationId,
  userId: uid,
  role,
  isPlatformAdmin: false,
});
const agentA = () => ctx(orgA, userId, "agent");
const viewerA = () => ctx(orgA, userId, "viewer");
const adminA = () => ctx(orgA, adminId, "admin");
const agentB = () => ctx(orgB, userB, "agent");

async function newTicket(channelUserId: string, messageId: string, timestamp: Date) {
  await withTenant(db, orgA, (tx) =>
    ingestChannelEvent(tx, connA, {
      event: {
        type: "message.received",
        externalMessageId: messageId,
        from: { channelUserId, displayName: "Cliente" },
        content: { type: "text", text: "qual o prazo de entrega?" },
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
  const members = await db
    .insert(users)
    .values([
      { name: "IT Draft A", email: `it-draft-a-${suffix}@crm.local` },
      { name: "IT Draft B", email: `it-draft-b-${suffix}@crm.local` },
      { name: "IT Draft Admin", email: `it-draft-admin-${suffix}@crm.local` },
    ])
    .returning({ id: users.id });
  userId = members[0]!.id;
  userB = members[1]!.id;
  adminId = members[2]!.id;

  const orgs = await db
    .insert(organizations)
    .values([
      { name: "Drafts IT A", slug: `draft-a-${suffix}` },
      { name: "Drafts IT B", slug: `draft-b-${suffix}` },
    ])
    .returning({ id: organizations.id });
  orgA = orgs[0]!.id;
  orgB = orgs[1]!.id;

  await db.insert(organizationMembers).values([
    { organizationId: orgA, userId, role: "agent" },
    { organizationId: orgA, userId: adminId, role: "admin" },
    { organizationId: orgB, userId: userB, role: "agent" },
  ]);

  connA = await withTenant(db, orgA, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgA,
        kind: "waha",
        name: "IT Draft WAHA",
        credentialsEncrypted: "not-used-in-these-tests",
        webhookToken: `tok-draft-${suffix}`,
      })
      .returning();
    return { id: row!.id, organizationId: orgA, kind: row!.kind };
  });
}, 60_000);

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.delete(users).where(sql`${users.id} in (${userId}, ${userB}, ${adminId})`);
  await db.$client.end();
});

describe("drafts", () => {
  it("creates a pending draft and supersedes the previous one", async () => {
    const ticket = await newTicket("draft-1@c.us", "false_d1@c.us_1", new Date("2024-05-01"));

    const first = await createDraftSuggestion(db, orgA, {
      conversationId: ticket.id,
      payload: { body: "Entrega em 5 dias úteis." },
      rationale: "prazo padrão",
    });
    expect(first.targetType).toBe("draft");
    expect(first.status).toBe("pending");
    expect(first.sourceConversationId).toBe(ticket.id);

    const second = await createDraftSuggestion(db, orgA, {
      conversationId: ticket.id,
      payload: { body: "Atualizado: 5 dias úteis." },
      rationale: "regenerado",
    });
    const pending = await listThreadCards(db, agentA(), ticket.id);
    expect(pending.map((d) => d.id)).toEqual([second.id]);
  });

  it("approve sends the body through the channel and marks reviewed", async () => {
    const ticket = await newTicket("draft-2@c.us", "false_d2@c.us_1", new Date("2024-05-01"));
    const draft = await createDraftSuggestion(db, orgA, {
      conversationId: ticket.id,
      payload: { body: "Posso confirmar seu pedido?" },
      rationale: "confirmação",
    });
    const provider = new FakeChannelProvider();

    const approved = await approveDraft(db, agentA(), {
      suggestionId: draft.id,
      deps: { provider },
    });
    expect(approved.status).toBe("approved");
    expect(approved.reviewedBy).toBe(userId);
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]!.content).toMatchObject({
      type: "text",
      text: "Posso confirmar seu pedido?",
    });

    // Idempotent re-approve — no second provider call.
    const again = await approveDraft(db, agentA(), { suggestionId: draft.id, deps: { provider } });
    expect(again.status).toBe("approved");
    expect(provider.sentMessages).toHaveLength(1);

    // The card leaves the pending list once reviewed.
    expect(await listThreadCards(db, agentA(), ticket.id)).toHaveLength(0);
  });

  it("rejects, blocks re-approve, and is idempotent", async () => {
    const ticket = await newTicket("draft-3@c.us", "false_d3@c.us_1", new Date("2024-05-01"));
    const draft = await createDraftSuggestion(db, orgA, {
      conversationId: ticket.id,
      payload: { body: "texto" },
      rationale: "r",
    });

    const rejected = await rejectDraft(db, agentA(), draft.id);
    expect(rejected.status).toBe("rejected");

    await expect(
      approveDraft(db, agentA(), {
        suggestionId: draft.id,
        deps: { provider: new FakeChannelProvider() },
      }),
    ).rejects.toMatchObject({ code: "DRAFT_ALREADY_REVIEWED" });
    expect((await rejectDraft(db, agentA(), draft.id)).status).toBe("rejected");
  });

  it("enforces messaging:write and tenant isolation", async () => {
    const ticket = await newTicket("draft-4@c.us", "false_d4@c.us_1", new Date("2024-05-01"));
    const draft = await createDraftSuggestion(db, orgA, {
      conversationId: ticket.id,
      payload: { body: "texto" },
      rationale: "r",
    });

    await expect(listThreadCards(db, viewerA(), ticket.id)).rejects.toThrowError(
      AuthorizationError,
    );
    await expect(approveDraft(db, viewerA(), { suggestionId: draft.id })).rejects.toThrowError(
      AuthorizationError,
    );
    await expect(rejectDraft(db, viewerA(), draft.id)).rejects.toThrowError(AuthorizationError);

    await expect(approveDraft(db, agentB(), { suggestionId: draft.id })).rejects.toThrowError(
      NotFoundError,
    );
    await expect(rejectDraft(db, agentB(), draft.id)).rejects.toThrowError(NotFoundError);
  });

  it("keeps drafts out of the settings suggestion inbox", async () => {
    const ticket = await newTicket("draft-5@c.us", "false_d5@c.us_1", new Date("2024-05-01"));
    const draft = await createDraftSuggestion(db, orgA, {
      conversationId: ticket.id,
      payload: { body: "texto" },
      rationale: "r",
    });

    const inbox = await listAgentSuggestions(db, adminA(), { limit: 100 });
    expect(inbox.find((s) => s.id === draft.id)).toBeUndefined();
  });

  it("findOrCreateDrafter lazily creates one kind=drafter agent per org", async () => {
    const first = await findOrCreateDrafter(db, orgA);
    expect(first.kind).toBe("drafter");
    expect(first.organizationId).toBe(orgA);

    const again = await findOrCreateDrafter(db, orgA);
    expect(again.id).toBe(first.id);
  });

  it("nudge shares the pending card slot — a fresh draft supersedes it", async () => {
    const ticket = await newTicket("draft-6@c.us", "false_d6@c.us_1", new Date("2024-05-01"));

    const nudge = await createNudgeSuggestion(db, orgA, {
      conversationId: ticket.id,
      rationale: "Cliente aguardando há 20 min",
      idleMinutes: 20,
    });
    expect(nudge.targetType).toBe("nudge");
    expect(nudge.status).toBe("pending");
    expect(await listThreadCards(db, agentA(), ticket.id)).toHaveLength(1);

    await createDraftSuggestion(db, orgA, {
      conversationId: ticket.id,
      payload: { body: "texto" },
      rationale: "r",
    });
    const cards = await listThreadCards(db, agentA(), ticket.id);
    expect(cards.map((c) => c.targetType)).toEqual(["draft"]);
  });

  it("reviewNudge approves/rejects, guards target type and messaging:write", async () => {
    const ticket = await newTicket("draft-7@c.us", "false_d7@c.us_1", new Date("2024-05-01"));
    const nudge = await createNudgeSuggestion(db, orgA, {
      conversationId: ticket.id,
      rationale: "aguardando",
    });

    const approved = await reviewNudge(db, agentA(), {
      suggestionId: nudge.id,
      action: "approved",
    });
    expect(approved.status).toBe("approved");
    expect(approved.reviewedBy).toBe(userId);

    const second = await createNudgeSuggestion(db, orgA, {
      conversationId: ticket.id,
      rationale: "aguardando",
    });
    await expect(
      reviewNudge(db, viewerA(), { suggestionId: second.id, action: "rejected" }),
    ).rejects.toThrowError(AuthorizationError);
    expect(
      (await reviewNudge(db, agentA(), { suggestionId: second.id, action: "rejected" })).status,
    ).toBe("rejected");

    // Draft-shaped rows don't go through reviewNudge (type guard).
    const draft = await createDraftSuggestion(db, orgA, {
      conversationId: ticket.id,
      payload: { body: "texto" },
      rationale: "r",
    });
    await expect(
      reviewNudge(db, agentA(), { suggestionId: draft.id, action: "approved" }),
    ).rejects.toThrowError(NotFoundError);
  });

  it("nudge scan: idle inbound is a candidate and an internal note does not reset idleness", async () => {
    const ticket = await newTicket("draft-8@c.us", "false_d8@c.us_1", new Date("2024-05-01"));
    await withTenant(db, orgA, (tx) =>
      tx.update(conversations).set({ assigneeId: userId }).where(eq(conversations.id, ticket.id)),
    );

    const opts = { idleMinutes: 20, cooldownMinutes: 60 * 24 };
    const before = await withTenant(db, orgA, (tx) => listNudgeCandidates(tx, orgA, opts));
    expect(before.map((c) => c.id)).toContain(ticket.id);

    // Under the old correlated-subplan semantics this outbound private note
    // became the "last message" and suppressed the nudge — the denormalized
    // columns intentionally ignore notes (same rule as the inbox).
    await addInternalNote(db, agentA(), { conversationId: ticket.id, text: "nota interna" });
    const after = await withTenant(db, orgA, (tx) => listNudgeCandidates(tx, orgA, opts));
    expect(after.map((c) => c.id)).toContain(ticket.id);
  });

  it("nudge scan: a public outbound reply drops the candidate and stales a pending nudge", async () => {
    const ticket = await newTicket("draft-9@c.us", "false_d9@c.us_1", new Date("2024-05-01"));
    await withTenant(db, orgA, (tx) =>
      tx.update(conversations).set({ assigneeId: userId }).where(eq(conversations.id, ticket.id)),
    );
    await sendOutboundMessage(db, agentA(), {
      input: { conversationId: ticket.id, text: "já respondo" },
      deps: { provider: new FakeChannelProvider() },
    });

    const opts = { idleMinutes: 20, cooldownMinutes: 60 * 24 };
    const candidates = await withTenant(db, orgA, (tx) => listNudgeCandidates(tx, orgA, opts));
    expect(candidates.map((c) => c.id)).not.toContain(ticket.id);

    // A pending nudge whose predicate flipped (human already replied) is stale.
    const nudge = await createNudgeSuggestion(db, orgA, {
      conversationId: ticket.id,
      rationale: "aguardando",
    });
    const stale = await withTenant(db, orgA, (tx) => listStaleNudges(tx, orgA));
    expect(stale.map((s) => s.id)).toContain(nudge.id);
  });
});
