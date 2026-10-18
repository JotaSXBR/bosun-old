import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { crmAppRole, tenantPredicate } from "./audit";
import { organizations } from "./auth";

/**
 * One org's connection to an external account (today: Google Contacts).
 * `bundle_encrypted` holds an `encryptJson` payload (AES-256-GCM,
 * CHANNEL_CREDENTIALS_KEY) with the org's OAuth client + tokens — it never
 * leaves the server and is never returned by reads. `status`:
 * pending → connected → needs_reauth | error. One row per (org, provider).
 */
export const externalConnections = pgTable(
  "external_connections",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    status: text().notNull().default("pending"),
    bundleEncrypted: text().notNull(),
    accountEmail: text(),
    lastCheckedAt: timestamp({ withTimezone: true }),
    lastError: text(),
    // Consent for automatic Google sync: set by the first "Sincronizar agora".
    autoSyncSince: timestamp({ withTimezone: true }),
    lastSweepAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("external_connections_org_provider_idx").on(t.organizationId, t.provider),
    pgPolicy("external_connections_tenant_isolation", {
      for: "all",
      to: crmAppRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
