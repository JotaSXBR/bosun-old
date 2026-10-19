// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import type { RawWebhookRequest } from "@crm/billing";
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withPlatformScope, withServiceAccess, withTenant } from "@crm/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WebhookVerificationError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { setPlatformSetting } from "../platform";
import { handleAsaasWebhook } from "./service";

const {
  billingCustomers,
  billingPayments,
  billingSubscriptions,
  billingWebhookEvents,
  organizations,
  users,
} = schema;

// ASAAS_* resolve via platform_settings → env fallback; the env var here is
// the fallback path. ASAAS_API_KEY stays unset so ensureBillingCustomer
// exercises the not-configured path without network.
process.env.ASAAS_WEBHOOK_TOKEN = "it-asaas-webhook-token";
const WEBHOOK_TOKEN = "it-asaas-webhook-token";

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
let subscriptionId: string;

function asaasRequest(payload: unknown, token = WEBHOOK_TOKEN): RawWebhookRequest {
  return {
    rawBody: JSON.stringify(payload),
    headers: { "content-type": "application/json", "asaas-access-token": token },
    query: {},
  };
}

function paymentEvent(eventN: number, paymentN: number, event: string): Record<string, unknown> {
  return {
    id: `evt_${suffix}_${eventN}`,
    event,
    dateCreated: "2026-10-03T10:00:00.000Z",
    payment: {
      id: `pay_${suffix}_${paymentN}`,
      customer: customerExternalId,
      subscription: subscriptionExternalId,
      status: event.replace("PAYMENT_", ""),
      value: 199.9,
      dueDate: "2026-10-10",
      ...(event === "PAYMENT_RECEIVED" ? { paymentDate: "2026-10-03" } : {}),
      billingType: "PIX",
    },
  };
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
    subscriptionId = sub!.id;
  });
});

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.delete(users).where(sql`${users.id} = ${userId}`);
  await db.$client.end();
});

describe("handleAsaasWebhook", () => {
  it("rejects a bad webhook token (WebhookVerificationError → 401 at the route)", async () => {
    await expect(
      handleAsaasWebhook(db, asaasRequest(paymentEvent(1, 1, "PAYMENT_CREATED"), "wrong")),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("rejects an unparseable body / invalid envelope", async () => {
    await expect(
      handleAsaasWebhook(db, {
        rawBody: "not-json",
        headers: { "asaas-access-token": WEBHOOK_TOKEN },
        query: {},
      }),
    ).rejects.toMatchObject({ code: "INVALID_WEBHOOK_PAYLOAD" });
    await expect(handleAsaasWebhook(db, asaasRequest({ nope: true }))).rejects.toMatchObject({
      code: "INVALID_WEBHOOK_PAYLOAD",
    });
  });

  it("records the event and upserts the payment with mapped status", async () => {
    const created = await handleAsaasWebhook(
      db,
      asaasRequest(paymentEvent(1, 1, "PAYMENT_CREATED")),
    );
    expect(created).toEqual({ ok: true, processed: true });

    // Status transition on the same ASAAS payment id updates the same row.
    const received = await handleAsaasWebhook(
      db,
      asaasRequest(paymentEvent(2, 1, "PAYMENT_RECEIVED")),
    );
    expect(received).toEqual({ ok: true, processed: true });

    await withTenant(db, orgA, async (tx) => {
      const payments = await tx.select().from(billingPayments);
      expect(payments).toHaveLength(1);
      expect(payments[0]!.externalId).toBe(`pay_${suffix}_1`);
      expect(payments[0]!.status).toBe("received");
      expect(payments[0]!.amountCents).toBe(19990);
      expect(payments[0]!.organizationId).toBe(orgA);
      expect(payments[0]!.billingSubscriptionId).toBe(subscriptionId);
      expect(payments[0]!.dueDate).toBe("2026-10-10");
      expect(payments[0]!.paidAt).toEqual(new Date("2026-10-03T00:00:00.000Z"));

      const events = await tx.select().from(billingWebhookEvents);
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.organizationId === orgA)).toBe(true);
      expect(events.every((e) => e.processedAt !== null)).toBe(true);
    });
  });

  it("treats an exact replay as duplicate — no extra event or payment rows", async () => {
    const replay = await handleAsaasWebhook(
      db,
      asaasRequest(paymentEvent(2, 1, "PAYMENT_RECEIVED")),
    );
    expect(replay).toEqual({ ok: true, duplicate: true });

    await withTenant(db, orgA, async (tx) => {
      expect(await tx.select().from(billingPayments)).toHaveLength(1);
      expect(await tx.select().from(billingWebhookEvents)).toHaveLength(2);
    });
  });

  it("records an event for an unknown customer, processes it, writes no payment", async () => {
    const payload = {
      id: `evt_${suffix}_unknown`,
      event: "PAYMENT_RECEIVED",
      payment: { id: `pay_${suffix}_unknown`, customer: "cus_not_ours", value: 10 },
    };
    const result = await handleAsaasWebhook(db, asaasRequest(payload));
    expect(result).toEqual({ ok: true, processed: true });

    // The null-org row is platform-internal: invisible inside any tenant,
    // visible under service/platform scope.
    const events = await withServiceAccess(db, (tx) =>
      tx.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.eventId, payload.id)),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.organizationId).toBeNull();
    expect(events[0]!.processedAt).not.toBeNull();
    expect(events[0]!.eventType).toBe("PAYMENT_RECEIVED");

    await withTenant(db, orgA, async (tx) => {
      const visible = await tx
        .select()
        .from(billingWebhookEvents)
        .where(eq(billingWebhookEvents.eventId, payload.id));
      expect(visible).toHaveLength(0);
      expect(
        await tx
          .select()
          .from(billingPayments)
          .where(eq(billingPayments.externalId, `pay_${suffix}_unknown`)),
      ).toHaveLength(0);
    });
  });

  it("records non-payment events without touching billing_payments", async () => {
    const payload = {
      id: `evt_${suffix}_sub`,
      event: "SUBSCRIPTION_DELETED",
      subscription: { id: subscriptionExternalId },
    };
    const result = await handleAsaasWebhook(db, asaasRequest(payload));
    expect(result).toEqual({ ok: true, processed: true });
    await withTenant(db, orgA, async (tx) => {
      expect(await tx.select().from(billingPayments)).toHaveLength(1);
    });
  });

  it("platform_settings.billing overrides env for webhook verification", async () => {
    const adminCtx: TenantContext = {
      organizationId: orgA,
      userId,
      role: "owner",
      isPlatformAdmin: true,
    };
    await setPlatformSetting(db, adminCtx, {
      group: "billing",
      input: {
        asaasApiKey: `db_key_${suffix}`,
        asaasEnvironment: "sandbox",
        asaasWebhookToken: `db_token_${suffix}`,
      },
    });
    try {
      // DB row wins: the env token no longer verifies.
      await expect(
        handleAsaasWebhook(db, asaasRequest(paymentEvent(901, 901, "PAYMENT_RECEIVED"))),
      ).rejects.toBeInstanceOf(WebhookVerificationError);
      // The DB token verifies and processes normally (non-payment event —
      // doesn't disturb the billing_payments assertions below).
      const result = await handleAsaasWebhook(
        db,
        asaasRequest(
          { id: `evt_${suffix}_dbcfg`, event: "SUBSCRIPTION_DELETED" },
          `db_token_${suffix}`,
        ),
      );
      expect(result).toEqual({ ok: true, processed: true });
    } finally {
      await withPlatformScope(db, (tx) =>
        tx.delete(schema.platformSettings).where(eq(schema.platformSettings.key, "billing")),
      );
    }
  });
});
