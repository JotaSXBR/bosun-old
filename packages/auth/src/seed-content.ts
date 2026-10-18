// Demo content seed — inserts seed-data.ts into the Demo org. Idempotent:
// every block keys off a natural id (contact channelUserId, conversation
// externalId, agent name, entry title) and skips what already exists.
// Conversations live in seed-threads.ts, AI content in seed-ai.ts.
import { createCipheriv, randomBytes } from "node:crypto";

import { schema } from "@crm/db";
import { and, eq } from "drizzle-orm";

import { ensureAiContent } from "./seed-ai";
import { DEMO_CONTACTS, WIDGET_VISITORS } from "./seed-data";
import { DEMO_DEALS } from "./seed-data-deals";
import { type IdMap, type SeedDb, ts } from "./seed-shared";
import { ensureConversations, type ThreadCtx } from "./seed-threads";

const {
  channelConnections,
  contacts,
  teams,
  labels,
  deals,
  dealLabels,
  funnelStages,
  funnels,
  siteChatSessions,
} = schema;

// Mirror of @crm/core/lib/crypto.ts encryptJson (auth can't depend on core):
// `v1.<iv>.<tag>.<ciphertext>` AES-256-GCM under CHANNEL_CREDENTIALS_KEY.
// Connections must store VALID ciphertext — a plaintext placeholder crashes
// decryptJson in providerForConnection (e.g. subscribeChatPresenceAction).
function encryptSeedCredential(value: unknown): string {
  const hex = process.env.CHANNEL_CREDENTIALS_KEY;
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("CHANNEL_CREDENTIALS_KEY must be set (64 hex) to seed demo connections");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hex, "hex"), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

const CONNECTION_CREDENTIALS: Record<string, unknown> = {
  waha: { baseUrl: "http://localhost:3001", apiKey: "seed-demo-key", session: "default" },
  site_chat: {},
};

async function ensureConnection(
  db: SeedDb,
  orgId: string,
  conn: { kind: string; name: string; webhookToken: string },
): Promise<string> {
  const { kind, name, webhookToken } = conn;
  const [existing] = await db
    .select({
      id: channelConnections.id,
      credentialsEncrypted: channelConnections.credentialsEncrypted,
    })
    .from(channelConnections)
    .where(eq(channelConnections.webhookToken, webhookToken))
    .limit(1);
  if (existing) {
    // Repair rows from before credentials were stored as real ciphertext.
    if (!existing.credentialsEncrypted.startsWith("v1.")) {
      await db
        .update(channelConnections)
        .set({ credentialsEncrypted: encryptSeedCredential(CONNECTION_CREDENTIALS[kind] ?? {}) })
        .where(eq(channelConnections.id, existing.id));
    }
    return existing.id;
  }

  const [created] = await db
    .insert(channelConnections)
    .values({
      organizationId: orgId,
      kind,
      name,
      externalRef: kind === "waha" ? "5511987654321" : "widget-bosun-io",
      status: "connected",
      credentialsEncrypted: encryptSeedCredential(CONNECTION_CREDENTIALS[kind] ?? {}),
      webhookToken,
      connectedAt: ts(30),
    })
    .returning({ id: channelConnections.id });
  if (!created) throw new Error(`failed to seed connection ${name}`);
  return created.id;
}

async function ensureContacts(
  db: SeedDb,
  orgId: string,
): Promise<Map<string, { id: string; channelUserId: string }>> {
  const map = new Map<string, { id: string; channelUserId: string }>();
  const all = [
    ...DEMO_CONTACTS,
    ...WIDGET_VISITORS.map((v) => ({
      key: v.key,
      channelUserId: v.email,
      displayName: v.displayName,
    })),
  ];
  for (const c of all) {
    let [row] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.organizationId, orgId), eq(contacts.channelUserId, c.channelUserId)))
      .limit(1);
    if (!row) {
      [row] = await db
        .insert(contacts)
        .values({
          organizationId: orgId,
          channelUserId: c.channelUserId,
          displayName: c.displayName,
        })
        .returning({ id: contacts.id });
    }
    if (row) map.set(c.key, { id: row.id, channelUserId: c.channelUserId });
  }
  return map;
}

type DealsCtx = Pick<
  ThreadCtx,
  "db" | "orgId" | "contactMap" | "convIdBySuffix" | "labelIdByName"
> & { funnelId: string };
type DealSpec = (typeof DEMO_DEALS)[number];

async function loadStageIds(db: SeedDb, funnelId: string): Promise<Map<string, string>> {
  const stages = await db
    .select({ id: funnelStages.id, name: funnelStages.name })
    .from(funnelStages)
    .where(eq(funnelStages.funnelId, funnelId));
  return new Map(stages.map((s) => [s.name, s.id]));
}

async function dealExists(ctx: DealsCtx, contactId: string, title: string): Promise<boolean> {
  const [existing] = await ctx.db
    .select({ id: deals.id })
    .from(deals)
    .where(
      and(
        eq(deals.organizationId, ctx.orgId),
        eq(deals.contactId, contactId),
        eq(deals.title, title),
      ),
    )
    .limit(1);
  return Boolean(existing);
}

async function insertDeal(
  ctx: DealsCtx,
  d: DealSpec,
  target: { contactId: string; stageId: string },
): Promise<string | undefined> {
  const [deal] = await ctx.db
    .insert(deals)
    .values({
      organizationId: ctx.orgId,
      funnelId: ctx.funnelId,
      stageId: target.stageId,
      contactId: target.contactId,
      conversationId: "conv" in d ? (ctx.convIdBySuffix.get(d.conv) ?? null) : null,
      title: d.title,
      valueCents: d.valueCents,
      position: d.position,
    })
    .returning({ id: deals.id });
  return deal?.id;
}

async function labelDeal(ctx: DealsCtx, dealId: string | undefined, d: DealSpec): Promise<void> {
  for (const labelName of "labels" in d ? d.labels : []) {
    const labelId = ctx.labelIdByName.get(labelName);
    if (dealId && labelId) {
      await ctx.db
        .insert(dealLabels)
        .values({ organizationId: ctx.orgId, dealId, labelId })
        .onConflictDoNothing();
    }
  }
}

async function ensureDeals(ctx: DealsCtx): Promise<void> {
  const stageIdByName = await loadStageIds(ctx.db, ctx.funnelId);

  for (const d of DEMO_DEALS) {
    const contact = ctx.contactMap.get(d.contactKey);
    const stageId = stageIdByName.get(d.stage);
    if (!contact || !stageId) continue;
    if (await dealExists(ctx, contact.id, d.title)) continue;

    const dealId = await insertDeal(ctx, d, { contactId: contact.id, stageId });
    await labelDeal(ctx, dealId, d);
  }
}

async function ensureDemoDeals(ctx: ThreadCtx): Promise<void> {
  const [funnel] = await ctx.db
    .select({ id: funnels.id })
    .from(funnels)
    .where(and(eq(funnels.organizationId, ctx.orgId), eq(funnels.name, "Pipeline Demo")))
    .limit(1);
  if (funnel) await ensureDeals({ ...ctx, funnelId: funnel.id });
}

async function ensureWidgetSessions(
  db: SeedDb,
  orgId: string,
  site: { connectionId: string; contactMap: Map<string, { id: string }> },
): Promise<void> {
  for (const v of WIDGET_VISITORS) {
    const contact = site.contactMap.get(v.key);
    if (!contact) continue;
    const token = `seed-widget-${v.key}`;
    const [existing] = await db
      .select({ id: siteChatSessions.id })
      .from(siteChatSessions)
      .where(eq(siteChatSessions.token, token))
      .limit(1);
    if (existing) continue;
    await db.insert(siteChatSessions).values({
      organizationId: orgId,
      channelConnectionId: site.connectionId,
      contactId: contact.id,
      token,
      lastSeenAt: ts(0, 9),
    });
  }
}

async function loadLookups(db: SeedDb, orgId: string) {
  const orgTeams = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.organizationId, orgId));
  const orgLabels = await db
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .where(eq(labels.organizationId, orgId));
  return {
    teamIdByName: new Map(orgTeams.map((t) => [t.name === "Vendas" ? "vendas" : "suporte", t.id])),
    labelIdByName: new Map(orgLabels.map((l) => [l.name, l.id])),
  };
}

export async function ensureDemoContent(
  db: SeedDb,
  orgId: string,
  userIdByRole: IdMap,
): Promise<void> {
  const connId = {
    waha: await ensureConnection(db, orgId, {
      kind: "waha",
      name: "WhatsApp Comercial",
      webhookToken: "seed-waha-demo",
    }),
    site: await ensureConnection(db, orgId, {
      kind: "site_chat",
      name: "Widget site bosun.io",
      webhookToken: "seed-site-demo",
    }),
  };
  const contactMap = await ensureContacts(db, orgId);
  const { teamIdByName, labelIdByName } = await loadLookups(db, orgId);

  const ctx: ThreadCtx = {
    db,
    orgId,
    connId,
    contactMap,
    userIdByRole,
    teamIdByName,
    labelIdByName,
    convIdBySuffix: new Map(),
  };
  const convIdBySuffix = await ensureConversations(ctx);
  await ensureDemoDeals(ctx);

  const ownerId = userIdByRole.get("owner") ?? [...userIdByRole.values()][0];
  await ensureAiContent(db, orgId, { ownerId, convIdBySuffix });
  await ensureWidgetSessions(db, orgId, { connectionId: connId.site, contactMap });
}
