// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { ensureBillingCustomer, getBillingSubscription, listBillingPayments } from "./service";

const { billingCustomers, billingPayments, billingSubscriptions, organizations, users } = schema;

// ASAAS_* resolve via platform_settings → env fallback; the env var here is
// the fallback path. ASAAS_API_KEY stays unset so ensureBillingCustomer
// exercises the not-configured path without network.
process.env.ASAAS_WEBHOOK_TOKEN = "it-asaas-webhook-token";

// encryptJson (setPlatformSetting) reads CHANNEL_CREDENTIALS_KEY lazily per
// call — provide a test key when the environment has none (CI has no .env).
process.env.CHANNEL_CREDENTIALS_KEY ??= "a".repeat(64);

let db: Database;
let orgA: string;
let orgB: string;
let userId: string;
let suffix: string;
let customerExternalId: string;
let subscriptionExternalId: string;

function ctx(organizationId: string, role: TenantContext["role"]): TenantContext {
  return { organizationId, userId, role, isPlatformAdmin: false };
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

  suffix = crypto.randomUUID().slice(0, 8);
  const [user] = await db
    .insert(users)
    .values({ name: "IT User", email: `it-billing-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  const orgs = await db
    .insert(organizations)
    .values([
      { name: "Billing IT A", slug: `bill-a-${suffix}` },
      { name: "Billing IT B", slug: `bill-b-${suffix}` },
    ])
    .returning({ id: organizations.id });
  orgA = orgs[0]!.id;
  orgB = orgs[1]!.id;

  customerExternalId = `cus_it_${suffix}`;
  subscriptionExternalId = `sub_it_${suffix}`;
  await withTenant(db, orgA, async (tx) => {
    const [customer] = await tx
      .insert(billingCustomers)
      .values({ organizationId: orgA, externalId: customerExternalId })
      .returning();
    const [sub] = await tx
      .insert(billingSubscriptions)
      .values({
        organizationId: orgA,
        billingCustomerId: customer!.id,
        externalId: subscriptionExternalId,
        status: "active",
        amountCents: 19990,
        cycle: "monthly",
        nextDueDate: "2026-11-01",
      })
      .returning();
    // One payment for org A: the webhook tests (service.int.test.ts) used to create it.
    await tx.insert(billingPayments).values({
      organizationId: orgA,
      billingSubscriptionId: sub!.id,
      externalId: `pay_it_${suffix}`,
      status: "received",
      amountCents: 19990,
    });
  });
});

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.delete(users).where(sql`${users.id} = ${userId}`);
  await db.$client.end();
});

describe("tenant RLS isolation (billing tables)", () => {
  it("org B sees none of org A's billing rows", async () => {
    for (const table of [billingCustomers, billingSubscriptions, billingPayments] as const) {
      const inB = await withTenant(db, orgB, (tx) => tx.select().from(table));
      expect(inB).toHaveLength(0);
      const inA = await withTenant(db, orgA, (tx) => tx.select().from(table));
      expect(inA.length).toBeGreaterThan(0);
      expect(inA.every((r) => r.organizationId === orgA)).toBe(true);
    }
  });

  it("an insert for org A inside an org B context is rejected", async () => {
    const error = await withTenant(db, orgB, (tx) =>
      tx.insert(billingCustomers).values({ organizationId: orgA, externalId: `cus_bad_${suffix}` }),
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
});

describe("org-facing billing reads", () => {
  it("listBillingPayments returns only the caller's org payments", async () => {
    const paymentsA = await listBillingPayments(db, ctx(orgA, "admin"));
    expect(paymentsA).toHaveLength(1);
    expect(paymentsA[0]!.organizationId).toBe(orgA);
    expect(await listBillingPayments(db, ctx(orgB, "admin"))).toHaveLength(0);
  });

  it("billing:read is owner/admin only — agent and manager are denied", async () => {
    await expect(listBillingPayments(db, ctx(orgA, "agent"))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(listBillingPayments(db, ctx(orgA, "manager"))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(getBillingSubscription(db, ctx(orgA, "agent"))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("getBillingSubscription returns the org's subscription, none for org B", async () => {
    const sub = await getBillingSubscription(db, ctx(orgA, "owner"));
    expect(sub?.externalId).toBe(subscriptionExternalId);
    expect(sub?.status).toBe("active");
    expect(await getBillingSubscription(db, ctx(orgB, "owner"))).toBeUndefined();
  });

  it("ensureBillingCustomer returns the existing customer without provider/env", async () => {
    const customer = await ensureBillingCustomer(db, ctx(orgA, "admin"), {
      name: "Billing IT A",
      email: "a@crm.local",
      cpfCnpj: "12345678901",
    });
    expect(customer.externalId).toBe(customerExternalId);
    expect(customer.organizationId).toBe(orgA);
  });

  it("ensureBillingCustomer fails cleanly when ASAAS_API_KEY is unset", async () => {
    await expect(
      ensureBillingCustomer(db, ctx(orgB, "admin"), {
        name: "Billing IT B",
        email: "b@crm.local",
        cpfCnpj: "12345678000199",
      }),
    ).rejects.toMatchObject({ code: "BILLING_NOT_CONFIGURED" });
  });

  it("ensureBillingCustomer validates input before any work", async () => {
    await expect(
      ensureBillingCustomer(db, ctx(orgA, "admin"), {
        name: "A",
        email: "a@crm.local",
        cpfCnpj: "bad",
      }),
    ).rejects.toThrowError();
    await expect(
      ensureBillingCustomer(db, ctx(orgA, "agent"), {
        name: "A",
        email: "a@crm.local",
        cpfCnpj: "12345678901",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
