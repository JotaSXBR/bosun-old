// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withServiceAccess, withTenant } from "@crm/db";
import { eq, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encryptJson } from "../../lib/crypto";
import { createWidgetSession, getWidgetConversation, sendWidgetMessage } from "./sitechat";

const { channelConnections, contacts, conversations, messages, organizations, siteChatSessions } =
  schema;

let db: Database;
let orgA: string;
let orgB: string;
let connA: { id: string; webhookToken: string };
let connOtherKind: { webhookToken: string };

async function insertConnection(
  organizationId: string,
  kind: string,
  webhookToken: string,
): Promise<{ id: string; webhookToken: string }> {
  return withTenant(db, organizationId, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId,
        kind,
        name: `IT ${kind}`,
        credentialsEncrypted: encryptJson({}),
        webhookToken,
      })
      .returning();
    return { id: row!.id, webhookToken };
  });
}

const PRE_FORM = { name: "Maria Silva", email: "maria@example.com", phone: "+55 (11) 98765-4321" };

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
  const mkOrg = async (name: string) => {
    const [org] = await db
      .insert(organizations)
      .values({ name, slug: `${name}-${suffix}` })
      .returning();
    return org!.id;
  };
  orgA = await mkOrg("it-sitechat-a");
  orgB = await mkOrg("it-sitechat-b");
  connA = await insertConnection(orgA, "site_chat", `itsc-${suffix}-a`);
  connOtherKind = await insertConnection(orgA, "waha", `itsc-${suffix}-waha`);
});

afterAll(async () => {
  for (const orgId of [orgA, orgB]) {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
  await db.$client.end();
});

describe("createWidgetSession", () => {
  it("creates a session + contact identified by email", async () => {
    const result = await createWidgetSession(db, connA.webhookToken, PRE_FORM);
    expect(result.sessionToken.length).toBeGreaterThan(20);
    expect(result.config.position).toBe("right");

    const [contact] = await withTenant(db, orgA, (tx) =>
      tx.select().from(contacts).where(eq(contacts.channelUserId, "maria@example.com")),
    );
    expect(contact?.displayName).toBe("Maria Silva");
    expect(contact?.metadata).toMatchObject({
      email: "maria@example.com",
      phone: "5511987654321",
      source: "site_chat",
    });
  });

  it("dedupes the contact when the same email opens a second session", async () => {
    const again = await createWidgetSession(db, connA.webhookToken, {
      ...PRE_FORM,
      name: "Maria S.",
    });
    expect(again.sessionToken.length).toBeGreaterThan(20);
    const rows = await withTenant(db, orgA, (tx) =>
      tx.select().from(contacts).where(eq(contacts.channelUserId, "maria@example.com")),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe("Maria S.");
  });

  it("rejects non-site_chat connections and invalid pre-forms", async () => {
    await expect(createWidgetSession(db, connOtherKind.webhookToken, PRE_FORM)).rejects.toThrow(
      "Widget connection",
    );
    await expect(
      createWidgetSession(db, connA.webhookToken, { ...PRE_FORM, email: "not-an-email" }),
    ).rejects.toThrow();
    await expect(
      createWidgetSession(db, connA.webhookToken, { ...PRE_FORM, phone: "123" }),
    ).rejects.toThrow();
    await expect(createWidgetSession(db, "no-such-token", PRE_FORM)).rejects.toThrow(
      "Widget connection",
    );
  });
});

describe("sendWidgetMessage + getWidgetConversation", () => {
  let sessionToken: string;

  it("ingests through the webhook pipeline into a conversation", async () => {
    ({ sessionToken } = await createWidgetSession(db, connA.webhookToken, {
      name: "João",
      email: "joao@example.com",
      phone: "5511911112222",
    }));
    const result = await sendWidgetMessage(db, sessionToken, {
      input: {
        text: "quero um orçamento",
        clientMessageId: "itsc-msg-1",
      },
    });
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.eventType).toBe("message.received");
    expect(result.processed[0]?.messageId).toBeTypeOf("string");

    const [conv] = await withTenant(db, orgA, (tx) =>
      tx.select().from(conversations).where(eq(conversations.channelConnectionId, connA.id)),
    );
    expect(conv?.externalId).toBe("joao@example.com");
    expect(conv?.status).toBe("open");
  });

  it("dedupes on clientMessageId retry", async () => {
    const replay = await sendWidgetMessage(db, sessionToken, {
      input: {
        text: "quero um orçamento",
        clientMessageId: "itsc-msg-1",
      },
    });
    expect(replay.processed).toEqual([{ eventType: "message.received", messageId: null }]);
  });

  it("widget history shows visitor + agent-visible messages only", async () => {
    const view = await getWidgetConversation(db, sessionToken);
    expect(view.conversation?.status).toBe("open");
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]).toMatchObject({ direction: "inbound", text: "quero um orçamento" });
  });

  it("hides internal notes and revoked messages from the visitor", async () => {
    const view = await getWidgetConversation(db, sessionToken);
    const convId = view.conversation!.id;
    await withTenant(db, orgA, async (tx) => {
      const [noteMsg] = await tx
        .insert(messages)
        .values({
          organizationId: orgA,
          conversationId: convId,
          channelConnectionId: connA.id,
          direction: "outbound",
          content: { type: "text", text: "nota interna" },
          private: true,
          status: "sent",
          sentAt: new Date(),
        })
        .returning();
      const [revokedMsg] = await tx
        .insert(messages)
        .values({
          organizationId: orgA,
          conversationId: convId,
          channelConnectionId: connA.id,
          direction: "outbound",
          content: { type: "text", text: "ops apagada" },
          revokedAt: new Date(),
          status: "sent",
          sentAt: new Date(),
        })
        .returning();
      expect(noteMsg && revokedMsg).toBeTruthy();
    });
    const after = await getWidgetConversation(db, sessionToken);
    expect(after.messages.map((m) => m.text)).not.toContain("nota interna");
    expect(after.messages.map((m) => m.text)).not.toContain("ops apagada");
  });

  it("rejects unknown session tokens", async () => {
    await expect(sendWidgetMessage(db, "bad-token", { input: { text: "oi" } })).rejects.toThrow(
      "Widget session",
    );
    await expect(getWidgetConversation(db, "bad-token")).rejects.toThrow("Widget session");
  });

  it("a new session with someone else's email sees nothing from before its creation", async () => {
    const first = await createWidgetSession(db, connA.webhookToken, {
      name: "Vitima",
      email: "vitima@example.com",
      phone: "5511900000001",
    });
    await sendWidgetMessage(db, first.sessionToken, {
      input: {
        text: "dados pessoais da vítima",
        clientMessageId: "itsc-sec-1",
      },
    });
    const own = await getWidgetConversation(db, first.sessionToken);
    expect(own.messages.map((m) => m.text)).toContain("dados pessoais da vítima");

    // Attacker knows only the visitor's email + the public embed token.
    const attacker = await createWidgetSession(db, connA.webhookToken, {
      name: "Atacante",
      email: "vitima@example.com",
      phone: "5511900000001",
    });
    const stolen = await getWidgetConversation(db, attacker.sessionToken);
    expect(stolen.conversation).toBeNull();
    expect(stolen.messages).toHaveLength(0);

    // From the new session onward the visitor sees only their own messages.
    await sendWidgetMessage(db, attacker.sessionToken, {
      input: {
        text: "oi de novo",
        clientMessageId: "itsc-sec-2",
      },
    });
    const after = await getWidgetConversation(db, attacker.sessionToken);
    expect(after.messages.map((m) => m.text)).toEqual(["oi de novo"]);
  });

  it("rejects sessions idle beyond 30 days", async () => {
    const { sessionToken: tk } = await createWidgetSession(db, connA.webhookToken, {
      name: "Dorminhoco",
      email: "dorme@example.com",
      phone: "5511900000002",
    });
    const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await withServiceAccess(db, (tx) =>
      tx.update(siteChatSessions).set({ lastSeenAt: stale }).where(eq(siteChatSessions.token, tk)),
    );
    await expect(getWidgetConversation(db, tk)).rejects.toThrow("Widget session");
    await expect(sendWidgetMessage(db, tk, { input: { text: "oi" } })).rejects.toThrow(
      "Widget session",
    );
  });

  it("throttles the session touch: a fresh session does not write on every read", async () => {
    const { sessionToken: tk } = await createWidgetSession(db, connA.webhookToken, {
      ...PRE_FORM,
      email: "throttle@example.com",
    });
    const readSeenAt = () =>
      withServiceAccess(db, async (tx) => {
        const [row] = await tx
          .select({ lastSeenAt: siteChatSessions.lastSeenAt })
          .from(siteChatSessions)
          .where(eq(siteChatSessions.token, tk));
        return row!.lastSeenAt;
      });

    // Stale session → the read refreshes lastSeenAt.
    const stale = new Date(Date.now() - 10 * 60_000);
    await withServiceAccess(db, (tx) =>
      tx.update(siteChatSessions).set({ lastSeenAt: stale }).where(eq(siteChatSessions.token, tk)),
    );
    await getWidgetConversation(db, tk);
    const afterStale = await readSeenAt();
    expect(afterStale.getTime()).toBeGreaterThan(stale.getTime());

    // Fresh session (inside the 5min window) → a poll must not write again.
    await getWidgetConversation(db, tk);
    expect(await readSeenAt()).toEqual(afterStale);
  });
});

describe("site_chat_sessions RLS", () => {
  it("tenant A cannot read org B sessions", async () => {
    const connB = await insertConnection(
      orgB,
      "site_chat",
      `itsc-${crypto.randomUUID().slice(0, 8)}-b`,
    );
    await createWidgetSession(db, connB.webhookToken, {
      name: "B User",
      email: "buser@example.com",
      phone: "5511999990000",
    });
    const visibleToA = await withTenant(db, orgA, (tx) =>
      tx
        .select({ id: siteChatSessions.id })
        .from(siteChatSessions)
        .where(ne(siteChatSessions.organizationId, orgA)),
    );
    expect(visibleToA).toHaveLength(0);
    const all = await withServiceAccess(db, (tx) =>
      tx.select({ id: siteChatSessions.id }).from(siteChatSessions),
    );
    expect(all.length).toBeGreaterThan(0);
  });
});
