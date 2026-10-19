import type { ChannelProvider, SendMessageResult } from "@crm/channels";
import { providerForConnection } from "@crm/core/integrations";
import type { Database } from "@crm/db";
import { emitDomainEvent, withTenant } from "@crm/db";

import { DomainError, NotFoundError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { assertTicketOwner, loadActiveTicket } from "./actions";
import type { ConversationRow, OutboundContent } from "./outbound-shared";
import { recordAgentReply } from "./outbound-shared";
import type { MessageRow } from "./repository";
import { getMessage, markMessageSent } from "./repository-messages";
import type { MessageActionInput } from "./schemas";
import { messageActionInput } from "./schemas";

type ResendDeps = { provider?: ChannelProvider; signUrl?: (storageKey: string) => Promise<string> };

async function loadResendable(
  db: Database,
  ctx: TenantContext,
  parsed: { conversationId: string; messageId: string },
): Promise<{ conversation: ConversationRow; message: MessageRow }> {
  return withTenant(db, ctx.organizationId, async (tx) => {
    const conv = await loadActiveTicket(tx, parsed.conversationId);
    assertTicketOwner(conv, ctx);
    const msg = await getMessage(tx, parsed.messageId);
    if (msg?.conversationId !== conv.id) {
      throw new NotFoundError("Message", parsed.messageId);
    }
    if (msg.direction !== "outbound" || msg.status !== "failed" || msg.private) {
      throw new DomainError(
        "MESSAGE_NOT_RESENDABLE",
        "Only failed outbound messages can be resent.",
      );
    }
    return { conversation: conv, message: msg };
  });
}

/** Media resends re-sign the stored upload: the original `source.url` expires after the send TTL. */
async function resendContent(
  message: MessageRow,
  signUrl: ResendDeps["signUrl"],
): Promise<OutboundContent> {
  const stored = message.content as OutboundContent;
  if (stored.type !== "media") return stored;
  if (!stored.storageKey || !signUrl) {
    throw new DomainError(
      "MESSAGE_NOT_RESENDABLE",
      "Media resend requires the stored upload (storageKey).",
    );
  }
  return { ...stored, source: { type: "url", url: await signUrl(stored.storageKey) } };
}

async function persistResentMessage(
  db: Database,
  ctx: TenantContext,
  {
    conversation,
    message,
    content,
    sent,
  }: {
    conversation: ConversationRow;
    message: MessageRow;
    content: OutboundContent;
    sent: SendMessageResult;
  },
): Promise<MessageRow> {
  const now = new Date();
  return withTenant(db, ctx.organizationId, async (tx) => {
    const current = await loadActiveTicket(tx, conversation.id);
    const updated = await markMessageSent(tx, message.id, {
      externalId: sent.externalId,
      status: sent.status,
      sentAt: now,
    });
    if (!updated) throw new Error("resend status raced — message no longer failed");
    await recordAgentReply(tx, ctx, { conversation, current, content, now });
    await emitDomainEvent(tx, {
      type: "message.updated",
      organizationId: ctx.organizationId,
      conversationId: conversation.id,
      messageId: updated.id,
    });
    return updated;
  });
}

/**
 * Requires messaging:write. Resends a `failed` outbound message through the
 * same row — the bubble flips to sent, no duplicate appears. Media resends
 * need `deps.signUrl`: the persisted storage key yields a fresh signed GET
 * (the original `source.url` expires after the send TTL).
 */
export async function resendFailedMessage(
  db: Database,
  ctx: TenantContext,
  { input, deps }: { input: MessageActionInput; deps?: ResendDeps },
): Promise<MessageRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const parsed = messageActionInput.parse(input);
  const { conversation, message } = await loadResendable(db, ctx, parsed);
  const provider =
    deps?.provider ??
    (await providerForConnection(db, ctx.organizationId, conversation.channelConnectionId));
  const content = await resendContent(message, deps?.signUrl);
  const sent = await provider
    .sendMessage({ to: conversation.externalId, content })
    .catch((cause: unknown) => {
      throw new DomainError(
        "SEND_FAILED",
        `Provider failed to resend the message: ${(cause as Error).message}`,
      );
    });
  return persistResentMessage(db, ctx, { conversation, message, content, sent });
}
