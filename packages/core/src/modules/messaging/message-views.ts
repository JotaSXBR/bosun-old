// Message-level reads with permission gates beyond messaging:read —
// revoked originals and edit history are privileged (owner/admin/manager),
// media lookup feeds the authenticated /api/media proxy route.
import type { MessageContent } from "@crm/channels";
import type { Database } from "@crm/db";
import { schema, withTenant } from "@crm/db";
import { createLogger } from "@crm/observability";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { AuthorizationError, DomainError, NotFoundError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { getLastInboundAt } from "./reads";
import type { MessageEditRow } from "./repository-messages";
import { getMessage, listMessageEdits as repoListMessageEdits } from "./repository-messages";
import type { ConversationIdInput, MessageActionInput } from "./schemas";
import { conversationIdInput, messageActionInput } from "./schemas";
import { canInspectMessageHistory } from "./service";

const { conversations } = schema;
const logger = createLogger({ bindings: { component: "messaging.media" } });

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const messageIdInput = z.object({ messageId: z.uuid() });

function assertMessageInspector(ctx: TenantContext): void {
  if (!canInspectMessageHistory(ctx)) {
    throw new AuthorizationError("Only owner/admin/manager can inspect message history");
  }
}

async function loadConversationMessage(
  db: Database,
  ctx: TenantContext,
  input: MessageActionInput,
) {
  const parsed = messageActionInput.parse(input);
  const message = await withTenant(db, ctx.organizationId, (tx) =>
    getMessage(tx, parsed.messageId),
  );
  if (message?.conversationId !== parsed.conversationId) {
    throw new NotFoundError("Message", parsed.messageId);
  }
  return message;
}

/**
 * Privileged: the stored (unredacted) content of a message — the "ver
 * original" behind the revoked placeholder. Regular members get redacted
 * content from listConversationMessages.
 */
export async function getMessageContent(
  db: Database,
  ctx: TenantContext,
  input: MessageActionInput,
): Promise<{ content: unknown; editedAt: Date | null; revokedAt: Date | null }> {
  assertPermission(ctx, { messaging: ["read"] });
  assertMessageInspector(ctx);
  const message = await loadConversationMessage(db, ctx, input);
  return { content: message.content, editedAt: message.editedAt, revokedAt: message.revokedAt };
}

/** Requires messaging:read. Last inbound timestamp — draft staleness check. */
export async function getConversationLastInboundAt(
  db: Database,
  ctx: TenantContext,
  input: ConversationIdInput,
): Promise<Date | null> {
  assertPermission(ctx, { messaging: ["read"] });
  const parsed = conversationIdInput.parse(input);
  return withTenant(db, ctx.organizationId, (tx) =>
    getLastInboundAt(tx, ctx.organizationId, parsed.conversationId),
  );
}

/** Privileged: previous versions of an edited message, newest first. */
export async function getMessageEdits(
  db: Database,
  ctx: TenantContext,
  input: MessageActionInput,
): Promise<MessageEditRow[]> {
  assertPermission(ctx, { messaging: ["read"] });
  assertMessageInspector(ctx);
  const parsed = messageActionInput.parse(input);
  await loadConversationMessage(db, ctx, input);
  return withTenant(db, ctx.organizationId, (tx) => repoListMessageEdits(tx, parsed.messageId));
}

/**
 * Requires messaging:read. Resolves a stored media message for the proxy
 * route: the content (url/storageKey/mime), the connection needed to
 * build the provider client, and the external ids (message + conversation
 * chatId) that the provider's by-id media download fallback needs.
 */
export async function getMessageMedia(
  db: Database,
  ctx: TenantContext,
  input: { messageId: string },
): Promise<{
  content: MessageContent;
  channelConnectionId: string;
  externalId: string | null;
  conversationExternalId: string | null;
}> {
  assertPermission(ctx, { messaging: ["read"] });
  const parsed = messageIdInput.parse(input);
  const { message, conversationExternalId } = await withTenant(
    db,
    ctx.organizationId,
    async (tx) => {
      const row = await getMessage(tx, parsed.messageId);
      if (!row) return { message: row, conversationExternalId: null };
      const [conv] = await tx
        .select({ externalId: conversations.externalId })
        .from(conversations)
        .where(eq(conversations.id, row.conversationId))
        .limit(1);
      return { message: row, conversationExternalId: conv?.externalId ?? null };
    },
  );
  if (!message) throw new NotFoundError("Message", parsed.messageId);
  // Revoked media follows the same role gate as the text "ver original".
  if (message.revokedAt && !canInspectMessageHistory(ctx)) {
    throw new AuthorizationError("Message media is restricted");
  }
  const content = message.content as MessageContent;
  if (content.type !== "media") {
    throw new DomainError("MESSAGE_NOT_MEDIA", "Message has no media content");
  }
  return {
    content,
    channelConnectionId: message.channelConnectionId,
    externalId: message.externalId,
    conversationExternalId,
  };
}

export type ResolvedMediaBody = {
  body: Uint8Array;
  contentType?: string | undefined;
  filename?: string | undefined;
};

/** Injected IO so the resolver stays provider/storage agnostic. */
export type MediaResolverDeps = {
  downloadObject?: (key: string) => Promise<ResolvedMediaBody>;
  fetchProviderMedia?: (
    channelConnectionId: string,
    url: string,
  ) => Promise<ResolvedMediaBody | null>;
  fetchMessageMedia?: (
    channelConnectionId: string,
    chatId: string,
    messageExternalId: string,
  ) => Promise<ResolvedMediaBody | null>;
};

type MediaContent = Extract<MessageContent, { type: "media" }>;

const withFallbackMeta = (media: ResolvedMediaBody, content: MediaContent): ResolvedMediaBody => ({
  body: media.body,
  contentType: media.contentType ?? content.mimeType,
  filename: content.filename,
});

/** Provider failures resolve to null so the proxy answers 404, not 500; only the message is logged. */
async function attemptFetch(
  { label, messageId }: { label: string; messageId: string },
  fetchMedia: () => Promise<ResolvedMediaBody | null>,
): Promise<ResolvedMediaBody | null> {
  try {
    return await fetchMedia();
  } catch (error) {
    logger.warn(label, { messageId, error: errMessage(error) });
    return null;
  }
}

/**
 * Stored url first (provider-hosted /api/files/* paths). When that fetch is
 * refused or dead, fall back to the provider's by-id download — sticker
 * payloads carry WhatsApp CDN .enc urls that aren't fetchable. Each stage
 * logs its own error (message only — never the url, which can carry signed
 * CDN params) or "media unavailable" stays invisible.
 */
async function fetchRemoteMedia(
  url: string,
  source: {
    messageId: string;
    channelConnectionId: string;
    externalId: string | null;
    conversationExternalId: string | null;
  },
  deps: MediaResolverDeps,
): Promise<ResolvedMediaBody | null> {
  const { messageId, channelConnectionId, externalId, conversationExternalId } = source;
  const { fetchProviderMedia, fetchMessageMedia } = deps;
  const byUrl = fetchProviderMedia
    ? await attemptFetch({ label: "media url fetch failed", messageId }, () =>
        fetchProviderMedia(channelConnectionId, url),
      )
    : null;
  if (byUrl) return byUrl;
  if (!fetchMessageMedia || !externalId || !conversationExternalId) return null;
  return attemptFetch({ label: "media by-id download failed", messageId }, () =>
    fetchMessageMedia(channelConnectionId, conversationExternalId, externalId),
  );
}

/** Outbound uploads: only tenant-owned keys are servable — the field is client-writable input on send, so the prefix is re-checked before any download. */
async function downloadTenantObject(
  organizationId: string,
  content: MediaContent,
  deps: MediaResolverDeps,
): Promise<ResolvedMediaBody | null> {
  const { storageKey } = content;
  if (!storageKey?.startsWith(`org/${organizationId}/`) || !deps.downloadObject) return null;
  return withFallbackMeta(await deps.downloadObject(storageKey), content);
}

/**
 * Downloads the bytes behind a media message: outbound uploads come from
 * object storage (tenant key), inbound media through the channel provider.
 * Returns null when there is no reachable source.
 */
export async function resolveMessageMedia(
  db: Database,
  ctx: TenantContext,
  { input, deps }: { input: { messageId: string }; deps: MediaResolverDeps },
): Promise<ResolvedMediaBody | null> {
  const row = await getMessageMedia(db, ctx, input);
  const { content } = row;
  if (content.type !== "media") return null;
  if (content.storageKey) return downloadTenantObject(ctx.organizationId, content, deps);
  if (content.source.type !== "url" || !content.source.url) return null;
  const media = await fetchRemoteMedia(
    content.source.url,
    { ...row, messageId: input.messageId },
    deps,
  );
  if (!media) {
    logger.warn("media unresolved", { messageId: input.messageId });
    return null;
  }
  return withFallbackMeta(media, content);
}
