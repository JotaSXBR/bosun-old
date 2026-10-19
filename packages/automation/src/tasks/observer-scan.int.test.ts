// Integration test — requires Postgres with migrations applied.
// observer-scan: deterministic interval sweep → nudge cards / auto-draft
// enqueues / stale-nudge cleanup, gated by org settings + BYOK credential.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { TenantContext } from "@crm/core";
import { createLlmCredential } from "@crm/core/ai";
import {
  createDraftSuggestion,
  createNudgeSuggestion,
  listThreadCards,
  rejectDraft,
} from "@crm/core/drafts";
import type { ConnectionRef } from "@crm/core/messaging";
import { ingestChannelEvent } from "@crm/core/messaging";
import { updateObserverSettings } from "@crm/core/organizations";
import type { Database } from "@crm/db";
import { createDb, schema, sql, withTenant } from "@crm/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { observerScanHandler } from "./observer-scan";

const {
  channelConnections,
  conversations,
  organizationMembers,
  organizations,
  organizationSettings,
  users,
} = schema;

let db: Database;
let orgA: string;
let userId: string;
let connA: ConnectionRef;

function ctx(organizationId: string): TenantContext {
  return { organizationId, userId, role: "admin", isPlatformAdmin: false };
}

const IDLE_MINUTES = 15;
const longAgo = new Date(Date.now() - 60 * 60 * 1000);

/** Ingests an old inbound message and assigns the ticket to the test user. */
async function idleTicket(chatId: string, messageId: string, assign = true) {
  await withTenant(db, orgA, (tx) =>
    ingestChannelEvent(tx, connA, {
      event: {
        type: "message.received",
        externalMessageId: messageId,
        from: { channelUserId: chatId, displayName: "Cliente" },
        content: { type: "text", text: "alguém pode me ajudar?" },
        timestamp: longAgo,
      },
    }),
  );
  return withTenant(db, orgA, async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(sql`${conversations.externalId} = ${chatId}`)
      .orderBy(sql`${conversations.createdAt} desc`)
      .limit(1);
    await tx
      .update(conversations)
      .set({ assigneeId: assign ? userId : null })
      .where(sql`${conversations.id} = ${conv!.id}`);
    return conv!;
  });
}

async function setObserver(input: {
  aiObserverMode: "off" | "on_close" | "interval" | "realtime";
  observerAutoDraft?: boolean;
}) {
  await updateObserverSettings(db, ctx(orgA), {
    aiObserverMode: input.aiObserverMode,
    observerIntervalMinutes: IDLE_MINUTES,
    observerIdleMinutes: IDLE_MINUTES,
    observerAutoDraft: input.observerAutoDraft ?? false,
  });
  // Reset the cadence watermark — each test wants the org "due" again.
  await withTenant(db, orgA, (tx) =>
    tx
      .update(organizationSettings)
      .set({ observerLastScanAt: null })
      .where(sql`${organizationSettings.organizationId} = ${orgA}`),
  );
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
    .values({ name: "IT Scan", email: `it-scan-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  const [org] = await db
    .insert(organizations)
    .values({ name: "Scan IT A", slug: `scan-a-${suffix}` })
    .returning({ id: organizations.id });
  orgA = org!.id;
  await db.insert(organizationMembers).values({ organizationId: orgA, userId, role: "admin" });
  connA = await withTenant(db, orgA, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgA,
        kind: "waha",
        name: "IT Scan WAHA",
        credentialsEncrypted: "not-used",
        webhookToken: `tok-scan-${suffix}`,
      })
      .returning();
    return { id: row!.id, organizationId: orgA, kind: row!.kind };
  });
  await createLlmCredential(db, ctx(orgA), {
    provider: "openrouter",
    apiKey: "sk-or-scan-test",
    model: "openai/gpt-5-mini",
    priority: 0,
    label: "test",
    zdr: true,
  });
}, 60_000);

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} = ${orgA}`);
  await db.delete(users).where(sql`${users.id} = ${userId}`);
  await db.$client.end();
});

describe("observerScanHandler", () => {
  it("interval org with idle inbound ticket gets a nudge card", async () => {
    const ticket = await idleTicket("scan-1@c.us", "scan_n1_1");
    await setObserver({ aiObserverMode: "interval" });

    const result = await observerScanHandler({});

    expect(result.nudges).toBe(1);
    const cards = await listThreadCards(db, ctx(orgA), ticket.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.targetType).toBe("nudge");
    expect(cards[0]!.rationale).toContain("15");

    // Cooldown + pending-card predicates: an immediate rescan adds nothing.
    const again = await observerScanHandler({});
    expect(again.nudges).toBe(0);
    expect(await listThreadCards(db, ctx(orgA), ticket.id)).toHaveLength(1);
  });

  it("non-interval modes produce no nudges", async () => {
    // Unassigned — keeps it out of the candidate set on later scans too.
    await idleTicket("scan-2@c.us", "scan_n2_1", false);
    await setObserver({ aiObserverMode: "on_close" });

    const result = await observerScanHandler({});
    expect(result.nudges).toBe(0);
    await setObserver({ aiObserverMode: "interval" });
  });

  it("auto_draft enqueues the drafter instead of a nudge", async () => {
    const ticket = await idleTicket("scan-3@c.us", "scan_n3_1");
    await setObserver({ aiObserverMode: "interval", observerAutoDraft: true });
    const enqueued: Array<{ conversationId: string }> = [];

    const result = await observerScanHandler(
      {},
      {
        enqueueDraft: (payload) => {
          enqueued.push(payload);
          return Promise.resolve({ skipped: false });
        },
      },
    );

    expect(result.drafts).toBe(1);
    expect(result.nudges).toBe(0);
    expect(enqueued).toEqual([
      { organizationId: orgA, conversationId: ticket.id, mode: "suggest" },
    ]);
    expect(await listThreadCards(db, ctx(orgA), ticket.id)).toHaveLength(0);
    await setObserver({ aiObserverMode: "interval", observerAutoDraft: false });
  });

  it("a rejected draft cools down auto-draft re-enqueues", async () => {
    const ticket = await idleTicket("scan-5@c.us", "scan_n5_1");
    await setObserver({ aiObserverMode: "interval", observerAutoDraft: true });
    // The human discarded the last suggestion — the cooldown must hold, or
    // every scan tick pays for another draft they already rejected.
    const draft = await createDraftSuggestion(db, orgA, {
      conversationId: ticket.id,
      payload: { body: "rascunho rejeitado" },
      rationale: "test",
    });
    await rejectDraft(db, ctx(orgA), draft.id);
    const enqueued: Array<{ conversationId: string }> = [];

    await observerScanHandler(
      {},
      {
        enqueueDraft: (payload) => {
          enqueued.push(payload);
          return Promise.resolve({ skipped: false });
        },
      },
    );

    // Other idle tickets may still be enqueued — the assertion is that
    // THIS ticket's rejected draft cools it down for the cooldown window.
    expect(enqueued.map((e) => e.conversationId)).not.toContain(ticket.id);
    expect(await listThreadCards(db, ctx(orgA), ticket.id)).toHaveLength(0);
    await setObserver({ aiObserverMode: "interval", observerAutoDraft: false });
  });

  it("cleanup supersedes a pending nudge when the predicate stops holding", async () => {
    const ticket = await idleTicket("scan-4@c.us", "scan_n4_1");
    await setObserver({ aiObserverMode: "interval" });
    await createNudgeSuggestion(db, orgA, {
      conversationId: ticket.id,
      rationale: "nudge antigo",
    });

    // Human was unassigned — the nudge no longer applies.
    await withTenant(db, orgA, (tx) =>
      tx
        .update(conversations)
        .set({ assigneeId: null })
        .where(sql`${conversations.id} = ${ticket.id}`),
    );
    const result = await observerScanHandler({});
    expect(result.cleaned).toBe(1);
    expect(await listThreadCards(db, ctx(orgA), ticket.id)).toHaveLength(0);
  });
});
