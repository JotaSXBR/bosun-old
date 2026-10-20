import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { crmAppRole, tenantPredicate } from "./audit";
import { organizations, users } from "./auth";
import { teams } from "./teams";

/**
 * A provider account connected by an organization (WAHA session, Meta Cloud
 * phone number). Credentials live encrypted in `credentials_encrypted`
 * (AES-256-GCM via @crm/core crypto); `webhook_token` is the unguessable path
 * segment that authenticates inbound webhooks before provider signature
 * verification.
 */
export const channelConnections = pgTable(
  "channel_connections",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    name: text().notNull(),
    externalRef: text(),
    status: text().notNull().default("pending"),
    credentialsEncrypted: text().notNull(),
    webhookToken: text().notNull(),
    connectedAt: timestamp({ withTimezone: true }),
    metadata: jsonb().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("channel_connections_webhook_token_idx").on(t.webhookToken),
    index("channel_connections_org_idx").on(t.organizationId),
    check("channel_connections_kind_check", sql`${t.kind} in ('waha', 'meta_cloud', 'site_chat')`),
    check(
      "channel_connections_status_check",
      sql`${t.status} in ('pending', 'connected', 'connecting', 'disconnected', 'error')`,
    ),
    pgPolicy("channel_connections_tenant_isolation", {
      for: "all",
      to: crmAppRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();

/**
 * A person on the other end of a channel, deduplicated per organization and
 * provider user id (WhatsApp chat id / phone number).
 */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelUserId: text().notNull(),
    displayName: text(),
    avatarUrl: text(),
    // Per-contact ticket sequence source — incremented in the same tx that
    // creates a ticket, so ticket_seq is that contact's Nth attendance.
    ticketCounter: bigint({ mode: "number" }).notNull().default(0),
    // Ficha fields (email/phone/notes) + provider extras (source, avatarKey…).
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("contacts_org_channel_user_idx").on(t.organizationId, t.channelUserId),
    // One WhatsApp `@lid` alias belongs to one contact per organization.
    uniqueIndex("contacts_org_lid_idx")
      .on(t.organizationId, sql`(${t.metadata}->>'lid')`)
      .where(sql`${t.metadata}->>'lid' is not null`),
    index("contacts_org_idx").on(t.organizationId),
    pgPolicy("contacts_tenant_isolation", {
      for: "all",
      to: crmAppRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();

/**
 * One ticket per attendance episode on a (connection, provider chat id).
 * `resolved` is terminal for the CUSTOMER — a new inbound creates a NEW row
 * linked by `preceded_by_id` (Zendesk-style follow-up), so at most one
 * active row exists per chat (partial unique). Agents may reopen a resolved
 * ticket inside the org's reopen window
 * (`organization_settings.ticket_reopen_window_hours`); the scheduled sweep
 * materializes `closed` once the window expires — `closed` is final for the
 * ticket itself (follow-ups still start from it).
 * `ticket_number` is the org-wide sequence; `ticket_seq` is the contact's
 * Nth attendance. `resolved_at`/`resolved_by`/`first_response_at` feed
 * per-episode metrics.
 */
export const conversations = pgTable(
  "conversations",
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
    externalId: text().notNull(),
    status: text().notNull().default("open"),
    sectorId: uuid().references(() => teams.id, { onDelete: "set null" }),
    assigneeId: uuid().references(() => users.id, { onDelete: "set null" }),
    precededById: uuid().references((): AnyPgColumn => conversations.id, {
      onDelete: "set null",
    }),
    ticketNumber: bigint({ mode: "number" }).notNull(),
    ticketSeq: bigint({ mode: "number" }).notNull(),
    resolvedAt: timestamp({ withTimezone: true }),
    // Who closed it — audit + reopen window logic (cleared on reopen).
    resolvedById: uuid().references(() => users.id, { onDelete: "set null" }),
    // Deferred ticket — leaves every work view until the instant passes
    // (lazy un-snooze; no sweep job).
    snoozedUntil: timestamp({ withTimezone: true }),
    firstResponseAt: timestamp({ withTimezone: true }),
    lastMessageAt: timestamp({ withTimezone: true }),
    // Denormalized latest-CHANNEL-message fields — written by the same
    // call sites that bump lastMessageAt (private notes don't touch
    // them), refreshed on message edit/revoke. Reads never subquery
    // messages for the inbox list anymore.
    lastMessagePreview: text(),
    lastMessageDirection: text(),
    metadata: jsonb().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One ACTIVE ticket per chat — resolved/closed rows are excluded so
    // follow-ups coexist with the closed history.
    uniqueIndex("conversations_connection_external_idx")
      .on(t.channelConnectionId, t.externalId)
      .where(sql`${t.status} not in ('resolved', 'closed')`),
    // Full (non-partial) chat key + timeline — serves the terminal-status
    // follow-up lookup and the widget's latest-ticket fetch, both of which
    // the active-only partial unique index cannot cover.
    index("conversations_connection_external_created_idx").on(
      t.channelConnectionId,
      t.externalId,
      t.createdAt.desc(),
    ),
    index("conversations_org_last_message_idx").on(t.organizationId, t.lastMessageAt.desc()),
    index("conversations_org_status_idx").on(t.organizationId, t.status),
    index("conversations_org_sector_idx").on(t.organizationId, t.sectorId),
    index("conversations_org_assignee_idx").on(t.organizationId, t.assigneeId),
    index("conversations_org_snoozed_idx").on(t.organizationId, t.snoozedUntil),
    check(
      "conversations_status_check",
      sql`${t.status} in ('pending', 'open', 'in_progress', 'waiting_customer', 'resolved', 'closed')`,
    ),
    pgPolicy("conversations_tenant_isolation", {
      for: "all",
      to: crmAppRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();

/**
 * A normalized message (ChannelEvent MessageContent in `content`). The partial
 * unique index on (channel_connection_id, external_id) is the idempotency key
 * for webhook replays — inserts use ON CONFLICT DO NOTHING.
 */
export const messages = pgTable(
  "messages",
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
    channelConnectionId: uuid()
      .notNull()
      .references(() => channelConnections.id, { onDelete: "cascade" }),
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),
    direction: text().notNull(),
    content: jsonb().notNull(),
    externalId: text(),
    // Internal note — visible to the team, never sent to the customer.
    private: boolean().notNull().default(false),
    // Agent who authored an outbound reply or internal note (null = inbound).
    authorId: uuid().references(() => users.id, { onDelete: "set null" }),
    status: text().notNull().default("received"),
    sentAt: timestamp({ withTimezone: true }),
    // Remote "deleted for everyone" — content is preserved (audit); the UI
    // renders a placeholder and only admin/manager can expand the original.
    revokedAt: timestamp({ withTimezone: true }),
    // Cheap "editada" badge — full history lives in message_edits.
    editedAt: timestamp({ withTimezone: true }),
    metadata: jsonb().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_connection_external_idx")
      .on(t.channelConnectionId, t.externalId)
      .where(sql`${t.externalId} is not null`),
    // One off-hours auto-reply per conversation per org-local day — the
    // marker row reserves the slot atomically before the provider call.
    uniqueIndex("messages_off_hours_day_idx")
      .on(t.conversationId, sql`(metadata ->> 'autoReplyDay')`)
      .where(sql`${t.metadata} ->> 'system' = 'off_hours'`),
    // One unsupported-media auto-reply per ticket — same atomic reserve.
    uniqueIndex("messages_unsupported_media_idx")
      .on(t.conversationId)
      .where(sql`${t.metadata} ->> 'system' = 'unsupported_media'`),
    index("messages_conversation_sent_idx").on(t.conversationId, t.sentAt),
    // getLastInboundAt (detail render) orders by created_at — the sent_at
    // index can't serve it. Partial: inbound only, tiny on mixed threads.
    index("messages_conversation_inbound_created_idx")
      .on(t.conversationId, t.createdAt.desc())
      .where(sql`${t.direction} = 'inbound'`),
    check("messages_direction_check", sql`${t.direction} in ('inbound', 'outbound')`),
    check(
      "messages_status_check",
      sql`${t.status} in ('received', 'queued', 'sent', 'delivered', 'read', 'failed')`,
    ),
    pgPolicy("messages_tenant_isolation", {
      for: "all",
      to: crmAppRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();

/**
 * Append-only edit history — one row per edit with the content BEFORE it.
 * `edited_by_user_id` is set for agent edits done in Bosun; null means the
 * edit happened on WhatsApp (contact editing inbound, or the operator editing
 * from the phone) — the message's direction already says who authored it.
 */
export const messageEdits = pgTable(
  "message_edits",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid()
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    previousContent: jsonb().notNull(),
    editedByUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("message_edits_message_idx").on(t.messageId),
    pgPolicy("message_edits_tenant_isolation", {
      for: "all",
      to: crmAppRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();

/**
 * One reaction per actor per message (WhatsApp semantics — a new reaction
 * replaces the old). `reactor_key` identifies the actor without a join:
 * 'me' for reactions we sent from the channel device, the agent's user id
 * for Bosun-originated reactions, the contact's channelUserId for remote
 * ones. The unique index makes webhook replays idempotent.
 */
export const messageReactions = pgTable(
  "message_reactions",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid()
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    reactorKey: text().notNull(),
    emoji: text().notNull(),
    actorUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    actorChannelUserId: text(),
    fromMe: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("message_reactions_message_reactor_idx").on(t.messageId, t.reactorKey),
    index("message_reactions_message_idx").on(t.messageId),
    pgPolicy("message_reactions_tenant_isolation", {
      for: "all",
      to: crmAppRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();

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
