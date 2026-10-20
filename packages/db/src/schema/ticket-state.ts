import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  pgPolicy,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { crmAppRole, tenantPredicate } from "./audit";
import { organizations, users } from "./auth";
import { conversations } from "./messaging";

/**
 * Org-wide ticket sequence — one row per org, `value` is the last
 * `ticket_number` handed out. Incremented atomically inside the creating
 * transaction (row lock serializes concurrent ticket inserts).
 */
export const ticketCounters = pgTable(
  "ticket_counters",
  {
    organizationId: uuid()
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    value: bigint({ mode: "number" }).notNull().default(0),
  },
  () => [
    pgPolicy("ticket_counters_tenant_isolation", {
      for: "all",
      to: crmAppRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();

/**
 * Per-user read cursor on a conversation — `last_read_at` is bumped when
 * the user opens the thread or sends a message. The inbox list derives
 * `unread_count` from inbound messages newer than the cursor (null
 * cursor = everything unread). Spec: docs/product/channel-whatsapp.md §7.
 */
export const conversationReads = pgTable(
  "conversation_reads",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conversation_reads_conv_user_idx").on(t.conversationId, t.userId),
    index("conversation_reads_org_idx").on(t.organizationId),
    pgPolicy("conversation_reads_tenant_isolation", {
      for: "all",
      to: crmAppRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
