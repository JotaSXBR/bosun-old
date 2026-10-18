// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "./client";
import { createDb, schema } from "./client";
import { withPlatformScope, withTenant } from "./tenant";

const { auditLogs, organizations, platformSettings } = schema;

let db: Database;
let orgA: string;
let orgB: string;

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
  const rows = await db
    .insert(organizations)
    .values([
      { name: "IT Org A", slug: `it-a-${suffix}` },
      { name: "IT Org B", slug: `it-b-${suffix}` },
    ])
    .returning({ id: organizations.id });
  orgA = rows[0]!.id;
  orgB = rows[1]!.id;
}, 60_000);

afterAll(async () => {
  // Auth tables have no RLS; tenant tables (audit_logs) cascade with the org.
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.$client.end();
});

describe("database", () => {
  it("connects and has the vector extension", async () => {
    const rows = await db.execute<{ extname: string }>(
      sql`select extname from pg_extension where extname = 'vector'`,
    );
    expect(rows.map((r: { extname: string }) => r.extname)).toContain("vector");
  });

  it("generates uuidv7 ids by default", async () => {
    const id = await withTenant(db, orgA, async (tx) => {
      const [row] = await tx
        .insert(auditLogs)
        .values({ organizationId: orgA, action: "test.insert" })
        .returning({ id: auditLogs.id });
      return row!.id;
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("tenant RLS isolation", () => {
  it("org A context sees only its own rows", async () => {
    await withTenant(db, orgA, async (tx) => {
      await tx.insert(auditLogs).values({ organizationId: orgA, action: "test.a" });
    });
    await withTenant(db, orgB, async (tx) => {
      await tx.insert(auditLogs).values({ organizationId: orgB, action: "test.b" });
    });

    const inA = await withTenant(db, orgA, (tx) => tx.select().from(auditLogs));
    expect(inA.length).toBeGreaterThan(0);
    expect(inA.every((r) => r.organizationId === orgA)).toBe(true);
  });

  it("without tenant context, the app role sees nothing", async () => {
    const rows = await db.select().from(auditLogs);
    expect(rows).toHaveLength(0);
  });

  it("an insert for org B inside an org A context is rejected", async () => {
    // drizzle wraps the pg error; the RLS violation is on `cause`.
    const error = await withTenant(db, orgA, (tx) =>
      tx.insert(auditLogs).values({ organizationId: orgB, action: "test.xss" }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    const cause = (error as { cause?: Error }).cause;
    expect(String(cause?.message ?? (error as Error).message)).toMatch(
      /row-level security|row violates/i,
    );
  });

  it("rejects a non-uuid organization id", async () => {
    await expect(withTenant(db, "not-a-uuid", () => Promise.resolve())).rejects.toThrowError(
      /invalid organization id/i,
    );
  });

  it("platform scope sees every tenant's rows", async () => {
    const rows = await withPlatformScope(db, (tx) => tx.select().from(auditLogs));
    const orgIds = new Set(rows.map((r) => r.organizationId));
    expect(orgIds.has(orgA)).toBe(true);
    expect(orgIds.has(orgB)).toBe(true);
  });
});

describe("platform_settings RLS", () => {
  it("only platform-scope transactions can read or write", async () => {
    const key = `it-${crypto.randomUUID().slice(0, 8)}`;

    await withPlatformScope(db, async (tx) => {
      await tx.insert(platformSettings).values({ key, valueEncrypted: "v1.test" });
    });

    const platformRows = await withPlatformScope(db, (tx) =>
      tx.select().from(platformSettings).where(eq(platformSettings.key, key)),
    );
    expect(platformRows).toHaveLength(1);

    const tenantRows = await withTenant(db, orgA, (tx) =>
      tx.select().from(platformSettings).where(eq(platformSettings.key, key)),
    );
    expect(tenantRows).toHaveLength(0);

    const bareRows = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
    expect(bareRows).toHaveLength(0);

    const error = await withTenant(db, orgA, (tx) =>
      tx.insert(platformSettings).values({ key: `${key}-x`, valueEncrypted: "v1.x" }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();

    await withPlatformScope(db, (tx) =>
      tx.delete(platformSettings).where(eq(platformSettings.key, key)),
    );
  });
});
