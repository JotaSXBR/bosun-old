import { sql } from "drizzle-orm";
import { index, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { crmAppRole, tenantPredicate } from "./audit";
import { organizations, users } from "./auth";
/**
 * Org-level quick reply template ("macro"). `name` is the `/trigger`
 * slug typed in the composer; agents propose macros through
 * `agent_suggestions`, manager/admin/owner creates them directly.
 */
export const macros = pgTable(
  "macros",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    content: text().notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("macros_org_name_idx").on(t.organizationId, t.name),
    index("macros_org_idx").on(t.organizationId),
    pgPolicy("macros_tenant_isolation", {
      for: "all",
      to: crmAppRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
