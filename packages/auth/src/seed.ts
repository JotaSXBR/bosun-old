// Dev seed: platform admin + "Demo" org with one user per role.
// Idempotent: existing rows are reused. Refuses to run in production.
import { getServerEnv } from "@crm/config";
import { createDb, schema } from "@crm/db";
import { and, eq } from "drizzle-orm";

import { createAuth } from "./auth";
import { ensureDemoContent } from "./seed-content";

const PASSWORD = "Password123!";

const DEMO_ORG = { name: "Demo", slug: "demo" };
const USERS = [
  { email: "owner@crm.local", name: "Owner Demo", orgRole: "owner" },
  { email: "admin@crm.local", name: "Admin Demo", orgRole: "admin" },
  { email: "manager@crm.local", name: "Manager Demo", orgRole: "manager" },
  { email: "agent@crm.local", name: "Agent Demo", orgRole: "agent" },
  { email: "viewer@crm.local", name: "Viewer Demo", orgRole: "viewer" },
] as const;

// Demo sectors — idempotent by (org, name). Members are keyed by org role
// (the seed creates exactly one user per role).
const DEMO_TEAMS = [
  { name: "Vendas", color: "#22c55e", memberRoles: ["agent", "manager"] },
  { name: "Suporte", color: "#3b82f6", memberRoles: ["agent"] },
] as const;

const PLATFORM_ADMIN = { email: "superadmin@crm.local", name: "Platform Admin" };

// Demo funnel — mirrors FUNNEL_TEMPLATES["servicos"] in @crm/core/leads
// (kept inline so the seed has no core dependency). Idempotent by name.
const DEMO_FUNNEL = {
  name: "Pipeline Demo",
  templateRef: "servicos",
  stages: [
    { name: "Prospecção", color: "blue" },
    { name: "Qualificação", color: "indigo" },
    { name: "Proposta", color: "amber" },
    { name: "Em execução", color: "purple" },
    { name: "Concluído", color: "green" },
  ],
} as const;

const DEMO_LABELS = [
  { name: "Prioridade", color: "red" },
  { name: "Recorrente", color: "teal" },
] as const;

type SeedDb = ReturnType<typeof createDb>;
type SeedAuth = ReturnType<typeof createAuth>;

async function ensureUser(
  db: SeedDb,
  auth: SeedAuth,
  { email, name }: { email: string; name: string },
): Promise<string> {
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const result = await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name },
  });
  return result.user.id;
}

async function ensureDemoOrg(db: SeedDb): Promise<string> {
  const existing = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, DEMO_ORG.slug))
    .limit(1)
    .then((rows) => rows[0]);
  if (existing) return existing.id;

  const [created] = await db
    .insert(schema.organizations)
    .values({ name: DEMO_ORG.name, slug: DEMO_ORG.slug })
    .returning({ id: schema.organizations.id });
  if (!created) throw new Error("failed to create demo organization");
  return created.id;
}

async function ensureDemoTeams(
  db: SeedDb,
  orgId: string,
  userIdByRole: ReadonlyMap<string, string>,
): Promise<void> {
  for (const team of DEMO_TEAMS) {
    await db
      .insert(schema.teams)
      .values({ organizationId: orgId, name: team.name, color: team.color })
      .onConflictDoNothing();
    const [row] = await db
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(and(eq(schema.teams.organizationId, orgId), eq(schema.teams.name, team.name)))
      .limit(1);
    if (!row) throw new Error(`failed to seed team ${team.name}`);
    for (const role of team.memberRoles) {
      const userId = userIdByRole.get(role);
      if (!userId) continue;
      await db
        .insert(schema.teamMembers)
        .values({ organizationId: orgId, teamId: row.id, userId })
        .onConflictDoNothing();
    }
  }
}

async function ensureDemoFunnel(db: SeedDb, orgId: string): Promise<void> {
  let [funnel] = await db
    .select({ id: schema.funnels.id })
    .from(schema.funnels)
    .where(and(eq(schema.funnels.organizationId, orgId), eq(schema.funnels.name, DEMO_FUNNEL.name)))
    .limit(1);
  if (!funnel) {
    [funnel] = await db
      .insert(schema.funnels)
      .values({
        organizationId: orgId,
        name: DEMO_FUNNEL.name,
        templateRef: DEMO_FUNNEL.templateRef,
      })
      .returning({ id: schema.funnels.id });
  }
  if (!funnel) throw new Error("failed to seed demo funnel");
  for (const [position, stage] of DEMO_FUNNEL.stages.entries()) {
    await db
      .insert(schema.funnelStages)
      .values({
        organizationId: orgId,
        funnelId: funnel.id,
        name: stage.name,
        position,
        color: stage.color,
      })
      .onConflictDoNothing();
  }
  for (const label of DEMO_LABELS) {
    await db
      .insert(schema.labels)
      .values({ organizationId: orgId, name: label.name, color: label.color })
      .onConflictDoNothing();
  }
}

async function ensureDemoData(
  db: SeedDb,
  orgId: string,
  userIdByRole: ReadonlyMap<string, string>,
): Promise<void> {
  await ensureDemoTeams(db, orgId, userIdByRole);
  await ensureDemoFunnel(db, orgId);
}

async function ensurePlatformAdmin(db: SeedDb, auth: SeedAuth): Promise<void> {
  // users.role drives the better-auth admin plugin.
  const platformAdminId = await ensureUser(db, auth, PLATFORM_ADMIN);
  await db
    .update(schema.users)
    .set({ role: "platform_admin" })
    .where(eq(schema.users.id, platformAdminId));
}

async function ensureOrgMembers(
  db: SeedDb,
  auth: SeedAuth,
  orgId: string,
): Promise<Map<string, string>> {
  const userIdByRole = new Map<string, string>();
  for (const user of USERS) {
    const userId = await ensureUser(db, auth, user);
    userIdByRole.set(user.orgRole, userId);
    await db
      .insert(schema.organizationMembers)
      .values({ organizationId: orgId, userId, role: user.orgRole })
      .onConflictDoNothing();
  }
  return userIdByRole;
}

function printSummary(): void {
  console.log("Seed complete:");
  console.log(`  platform admin: ${PLATFORM_ADMIN.email} / ${PASSWORD}`);
  console.log(`  demo org "${DEMO_ORG.name}" (slug: ${DEMO_ORG.slug}):`);
  for (const user of USERS) {
    console.log(`    ${user.orgRole.padEnd(8)} ${user.email} / ${PASSWORD}`);
  }
}

function openSeedContext(): { db: SeedDb; auth: SeedAuth } {
  const env = getServerEnv();
  if (env.nodeEnv === "production") {
    throw new Error("db:seed refuses to run when NODE_ENV=production");
  }
  const db = createDb(env.database.adminUrl ?? env.database.url);
  return { db, auth: createAuth({ db, env }) };
}

async function main() {
  const { db, auth } = openSeedContext();

  await ensurePlatformAdmin(db, auth);
  const orgId = await ensureDemoOrg(db);
  const userIdByRole = await ensureOrgMembers(db, auth, orgId);

  await ensureDemoData(db, orgId, userIdByRole);
  await ensureDemoContent(db, orgId, userIdByRole);

  await db.$client.end();

  printSummary();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
