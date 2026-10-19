import type { ChannelEvent, ChannelProvider, RawWebhookRequest } from "@crm/channels";
import { providerForConnection, resolveWebhookConnection } from "@crm/core/integrations";
import type { Database, DbExecutor } from "@crm/db";
import { schema, withTenant } from "@crm/db";
import { captureException } from "@crm/observability";
import { eq } from "drizzle-orm";

import { NotFoundError, WebhookVerificationError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { getUserPreferences } from "../users";
import type {
  ConnectionRef,
  IngestDeps,
  IngestedEvent,
  WebhookIngestResult,
} from "./ingest-events";
import {
  ingestConnectionStatus,
  ingestContactPresence,
  ingestMessageEdited,
  ingestMessageReaction,
  ingestMessageRevoked,
  ingestMessageStatus,
} from "./ingest-events";
import { ingestMessageReceived } from "./ingest-received";
import type {
  ContactTicketRow,
  ConversationDetailRow,
  ConversationListRow,
  MessageSearchHit,
  MessageWithAuthorRow,
} from "./reads";
import {
  getConversationDetail as repoGetConversationDetail,
  listContactTickets as repoListContactTickets,
  listConversations,
  listConversationViewCounts,
  listMessages,
  listMessagesAround,
  searchConversationMessages as searchMessages,
} from "./reads";
import type { TransferToMeRow } from "./reads-transfers";
import { listTransfersTo } from "./reads-transfers";
import { upsertConversationRead } from "./repository";
import type {
  ContactTicketsInput,
  ConversationIdInput,
  ConversationView,
  ListConversationsInput,
  ListMessagesInput,
  MessagesAroundInput,
  SearchMessagesInput,
} from "./schemas";
import {
  contactTicketsInput,
  conversationIdInput,
  listConversationsInput,
  listMessagesInput,
  messagesAroundInput,
  searchMessagesInput,
} from "./schemas";

const { conversations } = schema;

export type {
  ChannelEventEnqueue,
  ConnectionRef,
  ContactAvatarEnqueue,
  IngestDeps,
  IngestedEvent,
  TranscribeEnqueue,
  WebhookIngestResult,
} from "./ingest-events";

export async function ingestChannelEvent(
  executor: DbExecutor,
  conn: ConnectionRef,
  { event, deps }: { event: ChannelEvent; deps?: IngestDeps },
): Promise<IngestedEvent> {
  switch (event.type) {
    case "message.received":
      return ingestMessageReceived(executor, conn, { event, deps });
    case "message.status":
      return ingestMessageStatus(executor, conn, { event, deps });
    case "connection.status":
      return ingestConnectionStatus(executor, conn, { event, deps });
    // Reactions/edits/revokes update an existing message — never enqueued
    // (they are not inbound messages; nothing to auto-reply to). Presence is
    // transient — notify-only, no enqueue.
    case "message.reaction":
      return ingestMessageReaction(executor, conn, event);
    case "message.edited":
      return ingestMessageEdited(executor, conn, event);
    case "message.revoked":
      return ingestMessageRevoked(executor, conn, event);
    case "contact.presence":
      return ingestContactPresence(executor, conn, event);
  }
}

/**
 * Full webhook pipeline: resolve connection by unguessable token (service
 * scope) → decrypt credentials → verify signature → parse → ingest each
 * event inside its tenant transaction. Throws NotFoundError for unknown
 * tokens and WebhookVerificationError for failed signatures.
 */
export async function ingestChannelWebhook(
  db: Database,
  webhookToken: string,
  { request, deps }: { request: RawWebhookRequest; deps?: IngestDeps },
): Promise<WebhookIngestResult> {
  const resolved = await resolveWebhookConnection(db, webhookToken);
  if (!resolved) throw new NotFoundError("Channel connection");
  const { connection, provider } = resolved;
  if (!provider.verifyWebhook(request)) {
    throw new WebhookVerificationError();
  }
  const processed: IngestedEvent[] = [];
  for (const event of provider.parseWebhook(request)) {
    processed.push(
      await withTenant(db, connection.organizationId, (tx) =>
        ingestChannelEvent(tx, connection, { event, deps }),
      ),
    );
  }
  return {
    organizationId: connection.organizationId,
    channelConnectionId: connection.id,
    processed,
  };
}

/** Requires messaging:read (every org member). */
export async function listTenantConversations(
  db: Database,
  ctx: TenantContext,
  input?: ListConversationsInput,
): Promise<ConversationListRow[]> {
  assertPermission(ctx, { messaging: ["read"] });
  const parsed = listConversationsInput.parse(input ?? {});
  return listConversations(db, ctx.organizationId, {
    view: parsed.view,
    limit: parsed.limit,
    userId: ctx.userId,
    search: parsed.search,
    channelConnectionId: parsed.channelConnectionId,
    sectorId: parsed.sectorId,
    awaitingReply: parsed.awaitingReply,
  });
}

/** Prior tickets of the conversation's contact — aside history. Requires messaging:read. */
export async function listContactTickets(
  db: Database,
  ctx: TenantContext,
  input: ContactTicketsInput,
): Promise<ContactTicketRow[]> {
  assertPermission(ctx, { messaging: ["read"] });
  const parsed = contactTicketsInput.parse(input);
  return repoListContactTickets(db, ctx.organizationId, {
    contactId: parsed.contactId,
    excludeConversationId: parsed.excludeConversationId,
  });
}

/** Per-tab counters for the inbox workbench. Requires messaging:read. */
export async function listConversationCounts(
  db: Database,
  ctx: TenantContext,
): Promise<Record<ConversationView, number>> {
  assertPermission(ctx, { messaging: ["read"] });
  return listConversationViewCounts(db, ctx.organizationId, ctx.userId);
}

/**
 * Recent "ticket landed on me" events for the alerts bell — the private
 * transfer notes transferConversation records. Requires messaging:read.
 */
export async function listMyTransfers(
  db: Database,
  ctx: TenantContext,
  opts?: { limit?: number; sinceDays?: number },
): Promise<TransferToMeRow[]> {
  assertPermission(ctx, { messaging: ["read"] });
  return listTransfersTo(db, ctx.organizationId, { userId: ctx.userId, ...opts });
}

/** Roles allowed to inspect revoked originals and edit history. */
export const MESSAGE_INSPECT_ROLES = new Set(["owner", "admin", "manager"]);

export function canInspectMessageHistory(ctx: TenantContext): boolean {
  return ctx.isPlatformAdmin || MESSAGE_INSPECT_ROLES.has(ctx.role);
}

/** Requires messaging:read (every org member). */
export async function listConversationMessages(
  db: Database,
  ctx: TenantContext,
  input: ListMessagesInput,
): Promise<MessageWithAuthorRow[]> {
  assertPermission(ctx, { messaging: ["read"] });
  const parsed = listMessagesInput.parse(input);
  const rows = await listMessages(db, ctx.organizationId, {
    conversationId: parsed.conversationId,
    limit: parsed.limit,
  });
  if (canInspectMessageHistory(ctx)) return rows;
  // Revoked content is kept for audit but redacted for non-privileged roles.
  return rows.map(redactRevoked);
}

function redactRevoked(row: MessageWithAuthorRow): MessageWithAuthorRow {
  return {
    ...row,
    content: row.revokedAt ? { type: "text" as const, text: "" } : row.content,
    quoted: row.quoted?.revoked ? { ...row.quoted, preview: null } : row.quoted,
  };
}

/**
 * Requires messaging:read (every org member). B1 thread search — matches
 * text/caption case-insensitively, returns hit metadata for the dropdown.
 */
export async function searchConversationMessages(
  db: Database,
  ctx: TenantContext,
  input: SearchMessagesInput,
): Promise<MessageSearchHit[]> {
  assertPermission(ctx, { messaging: ["read"] });
  const parsed = searchMessagesInput.parse(input);
  return searchMessages(db, ctx.organizationId, {
    conversationId: parsed.conversationId,
    query: parsed.query,
  });
}

/**
 * Requires messaging:read. B1 jump — the window around a search hit,
 * chronological, same revoked-redaction as the tail window.
 */
export async function listConversationMessagesAround(
  db: Database,
  ctx: TenantContext,
  input: MessagesAroundInput,
): Promise<MessageWithAuthorRow[]> {
  assertPermission(ctx, { messaging: ["read"] });
  const parsed = messagesAroundInput.parse(input);
  const rows = await listMessagesAround(db, ctx.organizationId, {
    conversationId: parsed.conversationId,
    messageId: parsed.messageId,
    radius: parsed.radius,
  });
  if (!rows) throw new NotFoundError("Message", parsed.messageId);
  if (canInspectMessageHistory(ctx)) return rows;
  return rows.map(redactRevoked);
}

/**
 * Requires messaging:read. Bumps the caller's read cursor on the
 * conversation — fired when the pane opens (plan 2 client marker) and
 * implicitly on send (outbound.ts). Throws NotFoundError on
 * unknown/cross-tenant id.
 *
 * Reading is the blue-tick signal (spec: seen = read, not reply): when the
 * customer messaged last, the attending human's read marks the chat seen —
 * pending threads are picked up by whoever opens them to respond, assumed
 * threads only by their assignee. Automated sends carry their own envelope
 * (outbound.ts), so this path is the human-read consumer. Best-effort: a
 * provider failure never blocks the cursor.
 */
export async function markConversationRead(
  db: Database,
  ctx: TenantContext,
  { input, deps }: { input: ConversationIdInput; deps?: { provider?: ChannelProvider } },
): Promise<void> {
  assertPermission(ctx, { messaging: ["read"] });
  const parsed = conversationIdInput.parse(input);
  const conversation = await withTenant(db, ctx.organizationId, async (tx) => {
    const [row] = await tx
      .select({
        id: conversations.id,
        externalId: conversations.externalId,
        channelConnectionId: conversations.channelConnectionId,
        lastMessageDirection: conversations.lastMessageDirection,
        assigneeId: conversations.assigneeId,
      })
      .from(conversations)
      .where(eq(conversations.id, parsed.conversationId))
      .limit(1);
    if (!row) throw new NotFoundError("Conversa");
    await upsertConversationRead(tx, {
      organizationId: ctx.organizationId,
      conversationId: parsed.conversationId,
      userId: ctx.userId,
    });
    return row;
  });
  const attending = conversation.assigneeId === null || conversation.assigneeId === ctx.userId;
  if (conversation.lastMessageDirection !== "inbound" || !attending) return;
  if (!(await getUserPreferences(db, ctx.userId)).sendSeen) return;
  // Best-effort end to end — a broken connection or provider must never
  // break the read cursor (the tick is a nicety, the cursor is not).
  try {
    const provider =
      deps?.provider ??
      (await providerForConnection(db, ctx.organizationId, conversation.channelConnectionId));
    await provider.sendSeen?.(conversation.externalId);
  } catch (error) {
    captureException(error, {
      op: "markConversationRead.sendSeen",
      conversationId: conversation.id,
    });
  }
}

/** Requires messaging:read. Throws NotFoundError on unknown/cross-tenant id. */
export async function getConversationDetail(
  db: Database,
  ctx: TenantContext,
  input: ConversationIdInput,
): Promise<ConversationDetailRow> {
  assertPermission(ctx, { messaging: ["read"] });
  const parsed = conversationIdInput.parse(input);
  const row = await withTenant(db, ctx.organizationId, (tx) =>
    repoGetConversationDetail(tx, parsed.conversationId),
  );
  if (!row) throw new NotFoundError("Conversa");
  return row;
}
