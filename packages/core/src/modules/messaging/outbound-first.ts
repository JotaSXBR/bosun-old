// Outbound-first conversation — an agent opens a ticket to a contact that
// never wrote in (or whose tickets are all resolved). The ticket is born
// in_progress and assigned to the caller; the first message goes out
// through the normal composer flow (sendChannelMessage → waiting_customer).
import { isWhatsAppChatId } from "@crm/core/contacts";
import type { Database } from "@crm/db";
import { emitDomainEvent, withTenant } from "@crm/db";

import { DomainError, NotFoundError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import type { ConversationRow } from "./repository";
import { findConnectionById, findContactForTicket, findOrCreateTicket } from "./repository";
import type { StartOutboundConversationInput } from "./schemas";
import { startOutboundConversationInput } from "./schemas";

export type StartOutboundResult = { conversation: ConversationRow; created: boolean };

function assertOutboundConnection(connection: { kind: string; name: string; status: string }) {
  if (connection.kind !== "waha") {
    throw new DomainError(
      "OUTBOUND_CHANNEL_UNSUPPORTED",
      `Outbound-first is only supported on WhatsApp (waha) connections, not "${connection.kind}"`,
    );
  }
  if (connection.status !== "connected") {
    throw new DomainError(
      "CONNECTION_NOT_CONNECTED",
      `Connection "${connection.name}" is not connected (status: ${connection.status})`,
    );
  }
}

function assertReachableContact(contact: { channelUserId: string }) {
  if (!isWhatsAppChatId(contact.channelUserId)) {
    throw new DomainError(
      "CONTACT_NOT_REACHABLE",
      "This contact has no WhatsApp identity (channelUserId is not a chat id)",
    );
  }
}

/**
 * Requires messaging:write. v1 is WhatsApp-only: the connection must be a
 * `waha` connection in `connected` status (Meta Cloud needs templates/24h
 * windows; site_chat is inbound-only), and the contact's channelUserId
 * must be a WhatsApp identity (`*@c.us`/`*@lid` — a site_chat contact
 * carries an e-mail there). When the chat already has an active ticket on
 * that connection it is returned unchanged (`created: false`) — the UI
 * just opens it; the partial unique index is the same guarantee inside
 * the write tx.
 */
export async function startOutboundConversation(
  db: Database,
  ctx: TenantContext,
  input: StartOutboundConversationInput,
): Promise<StartOutboundResult> {
  assertPermission(ctx, { messaging: ["write"] });
  const parsed = startOutboundConversationInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    const connection = await findConnectionById(tx, parsed.channelConnectionId);
    if (!connection) throw new NotFoundError("Channel connection", parsed.channelConnectionId);
    assertOutboundConnection(connection);
    const contact = await findContactForTicket(tx, parsed.contactId);
    if (!contact) throw new NotFoundError("Contact", parsed.contactId);
    assertReachableContact(contact);
    const { conversation, created } = await findOrCreateTicket(tx, {
      organizationId: ctx.organizationId,
      channelConnectionId: connection.id,
      contactId: contact.id,
      externalId: contact.channelUserId,
      status: "in_progress",
      assigneeId: ctx.userId,
    });
    if (created) {
      await emitDomainEvent(tx, {
        type: "conversation.created",
        organizationId: ctx.organizationId,
        conversationId: conversation.id,
        contactId: contact.id,
        channelConnectionId: connection.id,
      });
    }
    return { conversation, created };
  });
}
