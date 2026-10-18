import { sql } from "drizzle-orm";
import { index, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { crmAppRole, tenantPredicate } from "./audit";
import { organizations } from "./auth";
import { channelConnections, contacts } from "./messaging";
/**
 * A visitor session on a `site_chat` widget. The unguessable `token` is
 * what the public widget endpoints authorize against — it identifies the
 * contact the visitor claimed in the pre-form (no proof of email
 * ownership in v1; same trust level as any anonymous chat widget).
 * Tenant-scoped for RLS; public routes resolve by token under service
 * access, never by organization.
 */
export const siteChatSessions = pgTable(
  "site_chat_sessions",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelConnectionId: uuid()
      .notNull()
      .references(() => channelConnections.id, { onDelete: "cascade" }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    token: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("site_chat_sessions_token_idx").on(t.token),
    index("site_chat_sessions_org_idx").on(t.organizationId),
    index("site_chat_sessions_contact_idx").on(t.contactId),
    pgPolicy("site_chat_sessions_tenant_isolation", {
      for: "all",
      to: crmAppRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
