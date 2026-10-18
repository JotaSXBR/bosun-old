// Demo AI content seed — agents, knowledge, memory, suggestions and usage.
import { schema } from "@crm/db";
import { and, eq } from "drizzle-orm";

import { DEMO_AGENTS, DEMO_KNOWLEDGE, DEMO_MEMORY, DEMO_USAGE } from "./seed-data-ai";
import { type IdMap, type SeedDb, ts } from "./seed-shared";

const { agents, knowledgeEntries, memoryEntries, agentSuggestions, aiUsageEvents } = schema;

async function ensureAgents(db: SeedDb, orgId: string): Promise<void> {
  for (const a of DEMO_AGENTS) {
    const [existing] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.organizationId, orgId), eq(agents.name, a.name)))
      .limit(1);
    if (existing) continue;
    await db.insert(agents).values({
      organizationId: orgId,
      name: a.name,
      specialty: a.specialty,
      status: a.status,
      kind: "org",
      systemPrompt: a.systemPrompt,
      businessRules: "businessRules" in a ? a.businessRules : null,
      signatureLine: "signatureLine" in a ? a.signatureLine : null,
    });
  }
}

async function ensureKnowledge(db: SeedDb, orgId: string): Promise<void> {
  for (const k of DEMO_KNOWLEDGE) {
    const [existing] = await db
      .select({ id: knowledgeEntries.id })
      .from(knowledgeEntries)
      .where(and(eq(knowledgeEntries.organizationId, orgId), eq(knowledgeEntries.title, k.title)))
      .limit(1);
    if (existing) continue;
    await db
      .insert(knowledgeEntries)
      .values({ organizationId: orgId, title: k.title, content: k.content });
  }
}

async function ensureMemory(db: SeedDb, orgId: string, ownerId: string): Promise<void> {
  for (const m of DEMO_MEMORY) {
    const [existing] = await db
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(and(eq(memoryEntries.organizationId, orgId), eq(memoryEntries.content, m.content)))
      .limit(1);
    if (existing) continue;
    await db.insert(memoryEntries).values({
      organizationId: orgId,
      type: m.type,
      scope: "org",
      content: m.content,
      confidence: m.confidence,
      status: "canon",
      staleAfter: ts(-m.staleAfterDays),
      verifiedBy: ownerId,
      verifiedAt: ts(7),
    });
  }
}

async function ensureSuggestions(db: SeedDb, orgId: string, convIdBySuffix: IdMap): Promise<void> {
  const [any] = await db
    .select({ id: agentSuggestions.id })
    .from(agentSuggestions)
    .where(eq(agentSuggestions.organizationId, orgId))
    .limit(1);
  if (any) return;
  const ricardoConv = convIdBySuffix.get("ricardo") ?? null;
  await db.insert(agentSuggestions).values([
    {
      organizationId: orgId,
      targetType: "knowledge_entry",
      targetId: null,
      payload: {
        title: "Política de emissão de nota fiscal",
        content:
          "O Bosun não emite NF-e no produto. Para nota de serviço, encaminhe a solicitação ao financeiro informando CNPJ e plano contratado.",
      },
      rationale:
        "2 conversas recentes (Beto Campos, Ricardo Alves) perguntaram sobre NF-e e não há entrada de conhecimento cobrindo o tema.",
      status: "pending",
      sourceConversationId: convIdBySuffix.get("beto") ?? null,
      proposedBy: null,
    },
    {
      organizationId: orgId,
      targetType: "memory",
      targetId: null,
      payload: {
        type: "pattern",
        scope: "org",
        content:
          "Perguntas sobre isolamento/multi-tenant chegam de leads com 2+ unidades — indicador de fit Enterprise.",
        confidence: "medium",
        staleAfterDays: 90,
        sourceConversationIds: ricardoConv ? [ricardoConv] : [],
      },
      rationale: "Padrão observado em 3 conversas de prospects multi-unidade na última semana.",
      status: "pending",
      sourceConversationId: ricardoConv,
      proposedBy: null,
    },
  ]);
}

async function ensureUsage(db: SeedDb, orgId: string): Promise<void> {
  const [any] = await db
    .select({ id: aiUsageEvents.id })
    .from(aiUsageEvents)
    .where(eq(aiUsageEvents.organizationId, orgId))
    .limit(1);
  if (any) return;
  for (const u of DEMO_USAGE) {
    await db.insert(aiUsageEvents).values({
      organizationId: orgId,
      callKind: u.callKind,
      provider: u.provider,
      model: u.model,
      tokensIn: u.tokensIn,
      tokensOut: u.tokensOut,
      latencyMs: u.latencyMs,
      status: "status" in u ? u.status : "ok",
      createdAt: ts(u.daysAgo, 8),
    });
  }
}

export async function ensureAiContent(
  db: SeedDb,
  orgId: string,
  extras: { ownerId: string | undefined; convIdBySuffix: IdMap },
): Promise<void> {
  await ensureAgents(db, orgId);
  await ensureKnowledge(db, orgId);
  if (extras.ownerId) await ensureMemory(db, orgId, extras.ownerId);
  await ensureSuggestions(db, orgId, extras.convIdBySuffix);
  await ensureUsage(db, orgId);
}
