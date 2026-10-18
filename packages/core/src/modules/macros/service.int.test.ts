// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema } from "@crm/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError, NotFoundError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { listPendingMacroSuggestions, proposeMacroEntry } from "../suggestions";
import {
  approveMacroSuggestion,
  createMacro,
  deleteMacro,
  listOrgMacros,
  rejectMacroSuggestion,
  searchOrgMacros,
  updateMacro,
} from "./service";

const { organizationMembers, organizations, users } = schema;

let db: Database;
let orgA: string;
let orgB: string;
let memberA: string;
let memberA2: string;
let memberB: string;

function ctx(organizationId: string, userId: string, role: TenantContext["role"]): TenantContext {
  return { organizationId, userId, role, isPlatformAdmin: false };
}

const adminA = () => ctx(orgA, memberA, "admin");
const managerA = () => ctx(orgA, memberA, "manager");
const agentA = () => ctx(orgA, memberA, "agent");
/** Second org-A member — the four-eyes reviewer (proposer can't self-approve). */
const reviewerA = () => ctx(orgA, memberA2, "admin");

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
  const inserted = await db
    .insert(users)
    .values([
      { name: "Macro A", email: `it-macro-a-${suffix}@crm.local` },
      { name: "Macro A2", email: `it-macro-a2-${suffix}@crm.local` },
      { name: "Macro B", email: `it-macro-b-${suffix}@crm.local` },
    ])
    .returning({ id: users.id });
  [memberA, memberA2, memberB] = inserted.map((u) => u.id) as [string, string, string];

  const orgs = await db
    .insert(organizations)
    .values([
      { name: "Macros IT A", slug: `macro-a-${suffix}` },
      { name: "Macros IT B", slug: `macro-b-${suffix}` },
    ])
    .returning({ id: organizations.id });
  [orgA, orgB] = orgs.map((o) => o.id) as [string, string];

  await db.insert(organizationMembers).values([
    { organizationId: orgA, userId: memberA, role: "admin" },
    { organizationId: orgA, userId: memberA2, role: "admin" },
    { organizationId: orgB, userId: memberB, role: "admin" },
  ]);
});

afterAll(async () => {
  // Orgs cascade into macros/contact_labels/suggestions rows.
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.delete(users).where(sql`${users.id} in (${memberA}, ${memberA2}, ${memberB})`);
});

describe("macros service", () => {
  it("manager creates a macro; every member role can list it", async () => {
    const created = await createMacro(db, managerA(), {
      name: "saudacao",
      content: "Olá! Em que posso ajudar?",
    });
    expect(created.name).toBe("saudacao");

    const asAgent = await listOrgMacros(db, agentA());
    expect(asAgent.map((m) => m.name)).toContain("saudacao");
  });

  it("agent cannot create a macro directly", async () => {
    await expect(
      createMacro(db, agentA(), { name: "agente-macro", content: "x" }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("duplicate name is a domain error, not a raw pg error", async () => {
    await createMacro(db, adminA(), { name: "duplicada", content: "a" });
    await expect(
      createMacro(db, adminA(), { name: "duplicada", content: "b" }),
    ).rejects.toMatchObject({ code: "MACRO_NAME_TAKEN" });
  });

  it("search filters by prefix for the composer picker", async () => {
    await createMacro(db, adminA(), { name: "pagamento-boleto", content: "b" });
    await createMacro(db, adminA(), { name: "pagamento-pix", content: "p" });
    const hits = await searchOrgMacros(db, agentA(), "pagamento-");
    expect(hits.map((m) => m.name)).toEqual(
      expect.arrayContaining(["pagamento-boleto", "pagamento-pix"]),
    );
    const miss = await searchOrgMacros(db, agentA(), "zzz-nada");
    expect(miss).toEqual([]);
  });

  it("update and delete round-trip", async () => {
    const m = await createMacro(db, adminA(), { name: "editavel", content: "v1" });
    const updated = await updateMacro(db, adminA(), { macroId: m.id, input: { content: "v2" } });
    expect(updated.content).toBe("v2");
    await deleteMacro(db, adminA(), m.id);
    await expect(
      updateMacro(db, adminA(), { macroId: m.id, input: { content: "v3" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("macros are tenant-isolated", async () => {
    const rows = await listOrgMacros(db, ctx(orgB, memberB, "admin"));
    expect(rows.every((m) => m.organizationId === orgB)).toBe(true);
    expect(rows.map((m) => m.name)).not.toContain("saudacao");
  });
});

describe("macro suggestions (agent proposes → manager approves)", () => {
  it("agent proposal lands pending and approver materializes the macro", async () => {
    const suggestion = await proposeMacroEntry(db, agentA(), {
      name: "proposta-agente",
      content: "Texto proposto pelo agente",
      rationale: "Cliente pergunta isso toda hora",
    });
    expect(suggestion.status).toBe("pending");
    expect(suggestion.proposedBy).toBe(memberA);

    const pending = await listPendingMacroSuggestions(db, managerA());
    expect(pending.map((s) => s.id)).toContain(suggestion.id);

    // Four-eyes: a different org admin approves.
    await approveMacroSuggestion(db, reviewerA(), suggestion.id);

    const macrosA = await listOrgMacros(db, agentA());
    expect(macrosA.map((m) => m.name)).toContain("proposta-agente");
  });

  it("proposer cannot self-approve", async () => {
    // memberB proposes under orgB, then tries to approve as admin of orgB — blocked.
    const suggestion = await proposeMacroEntry(db, ctx(orgB, memberB, "agent"), {
      name: "self-approve",
      content: "x",
      rationale: "r",
    });
    await expect(
      approveMacroSuggestion(db, ctx(orgB, memberB, "admin"), suggestion.id),
    ).rejects.toMatchObject({ code: "SUGGESTION_SELF_APPROVE" });
  });

  it("reject leaves no macro behind; agent cannot review", async () => {
    const suggestion = await proposeMacroEntry(db, agentA(), {
      name: "rejeitada",
      content: "não entra",
      rationale: "teste",
    });
    await expect(rejectMacroSuggestion(db, agentA(), suggestion.id)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await rejectMacroSuggestion(db, reviewerA(), suggestion.id);
    const macrosA = await listOrgMacros(db, agentA());
    expect(macrosA.map((m) => m.name)).not.toContain("rejeitada");
  });
});
