// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
//
// Group ownership across int-test files (they run in parallel on one DB):
// this file touches only `email` and `ai`; billing tests own `billing`,
// integrations tests own `meta`.
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withPlatformScope } from "@crm/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { deletePlatformSettingRows, upsertPlatformSettingRow } from "./repository";
import {
  isProductConfigured,
  listPlatformSettingSummaries,
  resolveEmailConfig,
  resolveProductSettings,
  setPlatformSetting,
} from "./service";

const { organizations, users } = schema;

// encryptJson reads CHANNEL_CREDENTIALS_KEY lazily per call — provide a test
// key when the environment has none (CI has no .env).
process.env.CHANNEL_CREDENTIALS_KEY ??= "a".repeat(64);

let db: Database;
let orgId: string;
let userId: string;
const touchedKeys = ["ai", "email"];

function platformAdmin(): TenantContext {
  return { organizationId: orgId, userId, role: "owner", isPlatformAdmin: true };
}

function member(): TenantContext {
  return { organizationId: orgId, userId, role: "admin", isPlatformAdmin: false };
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
    .values({ name: "IT Platform", email: `it-platform-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  const [org] = await db
    .insert(organizations)
    .values({ name: "Core IT Platform", slug: `core-platform-${suffix}` })
    .returning({ id: organizations.id });
  orgId = org!.id;
}, 60_000);

afterAll(async () => {
  await withPlatformScope(db, (tx) => deletePlatformSettingRows(tx, touchedKeys));
  // beforeAll may have bailed before seeding (e.g. DB down) — don't emit
  // `where id = undefined` deletes on teardown.
  if (orgId) await db.delete(organizations).where(sql`${organizations.id} = ${orgId}`);
  if (userId) await db.delete(users).where(sql`${users.id} = ${userId}`);
  await db.$client.end();
});

describe("platform settings service", () => {
  it("rejects non-platform-admin callers", async () => {
    await expect(
      setPlatformSetting(db, member(), { group: "ai", input: { openaiApiKey: "x" } }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(listPlatformSettingSummaries(db, member())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("stores encrypted values — no plaintext reaches the table", async () => {
    await setPlatformSetting(db, platformAdmin(), {
      group: "ai",
      input: {
        openaiApiKey: "sk-it-openai-secret",
      },
    });
    const rows = await withPlatformScope(db, (tx) => tx.select().from(schema.platformSettings));
    const row = rows.find((r) => r.key === "ai");
    expect(row).toBeDefined();
    expect(row!.valueEncrypted).toMatch(/^v1\./);
    expect(row!.valueEncrypted).not.toContain("sk-it-openai-secret");
    expect(row!.updatedByUserId).toBe(userId);
  });

  it("resolved settings prefer DB over env, per field", async () => {
    const env = getServerEnv();
    const settings = await resolveProductSettings(db);
    expect(settings.ai.openaiApiKey).toBe("sk-it-openai-secret");
    // unset groups still resolve from env
    expect(settings.meta.graphApiVersion).toBe(env.whatsapp.meta.graphApiVersion);
    expect(await resolveEmailConfig(db)).toEqual(
      expect.objectContaining({ provider: env.email.provider }),
    );
  });

  it("field-merge preserves secrets left blank on update", async () => {
    await setPlatformSetting(db, platformAdmin(), {
      group: "ai",
      input: {
        openaiApiKey: "", // blank = keep stored
        anthropicApiKey: "sk-it-anthropic",
      },
    });
    const settings = await resolveProductSettings(db);
    expect(settings.ai.openaiApiKey).toBe("sk-it-openai-secret");
    expect(settings.ai.anthropicApiKey).toBe("sk-it-anthropic");
  });

  it("isProductConfigured reflects the resolved settings", async () => {
    expect(await isProductConfigured(db, "ai")).toBe(true);
    expect(await isProductConfigured(db, "meta")).toBe(
      Boolean(getServerEnv().whatsapp.meta.appSecret),
    );
  });

  it("nested smtp fields merge field-level", async () => {
    await setPlatformSetting(db, platformAdmin(), {
      group: "email",
      input: {
        provider: "smtp",
        from: "it@crm.local",
        smtp: { host: "smtp.example", port: 587, user: "u1", password: "p1", secure: false },
      },
    });
    await setPlatformSetting(db, platformAdmin(), {
      group: "email",
      input: {
        provider: "smtp",
        smtp: { password: "", secure: true }, // blank secret preserved
      },
    });
    const email = await resolveEmailConfig(db);
    expect(email.provider).toBe("smtp");
    expect(email.smtp.host).toBe("smtp.example");
    expect(email.smtp.password).toBe("p1");
    expect(email.smtp.secure).toBe(true);
    expect(await isProductConfigured(db, "email")).toBe(true);
  });

  it("summaries expose non-secret values and secret presence only", async () => {
    const summaries = await listPlatformSettingSummaries(db, platformAdmin());
    const email = summaries.find((s) => s.group === "email");
    expect(email).toBeDefined();
    expect(email!.configured).toBe(true);
    expect(email!.values.provider).toBe("smtp");
    expect(email!.values.from).toBe("it@crm.local");
    expect((email!.values.smtp as Record<string, unknown>).password).toBeUndefined();
    expect(email!.secretsSet["smtp.password"]).toBe(true);
    expect(email!.secretsSet.resendApiKey).toBe(Boolean(getServerEnv().email.resendApiKey));
    expect(email!.dbFields).toEqual(
      expect.arrayContaining(["provider", "from", "smtp.host", "smtp.password"]),
    );
    expect(email!.updatedAt).toBeInstanceOf(Date);

    const ai = summaries.find((s) => s.group === "ai");
    expect(ai!.secretsSet.openaiApiKey).toBe(true);
    expect(ai!.values.openaiApiKey).toBeUndefined();
  });

  it("blank non-secret fields clear the stored override back to env", async () => {
    // Stored from the earlier test: smtp config + from = "it@crm.local".
    await setPlatformSetting(db, platformAdmin(), { group: "email", input: { from: "" } });
    const email = await resolveEmailConfig(db);
    expect(email.from).toBe(getServerEnv().email.from);
    expect(email.smtp.host).toBe("smtp.example"); // untouched
    // Summary no longer lists `from` among DB-overridden fields.
    const summary = (await listPlatformSettingSummaries(db, platformAdmin())).find(
      (s) => s.group === "email",
    );
    expect(summary!.dbFields).not.toContain("from");
    expect(summary!.dbFields).toContain("smtp.host");
  });

  it("corrupt blobs fall back to env and self-heal on the next save", async () => {
    await withPlatformScope(db, (tx) =>
      upsertPlatformSettingRow(tx, "ai", {
        valueEncrypted: "not-a-valid-payload",
        updatedByUserId: userId,
      }),
    );
    const env = getServerEnv();
    const settings = await resolveProductSettings(db);
    expect(settings.ai.openaiApiKey).toBe(env.ai.openaiApiKey);
    const summary = (await listPlatformSettingSummaries(db, platformAdmin())).find(
      (s) => s.group === "ai",
    );
    expect(summary!.secretsSet.openaiApiKey).toBe(Boolean(env.ai.openaiApiKey));
    // The corrupt row is skipped on read — a fresh save starts clean.
    await setPlatformSetting(db, platformAdmin(), {
      group: "ai",
      input: { openaiApiKey: "sk-it-healed" },
    });
    expect((await resolveProductSettings(db)).ai.openaiApiKey).toBe("sk-it-healed");
  });

  it("tenant-scoped transactions cannot see platform rows", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.organization_id', ${orgId}, true)`);
      return tx.select().from(schema.platformSettings);
    });
    expect(rows.filter((r) => touchedKeys.includes(r.key))).toHaveLength(0);
  });
});
