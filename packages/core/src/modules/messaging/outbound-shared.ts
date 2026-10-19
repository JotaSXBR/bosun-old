import type { OutboundMessage } from "@crm/channels";
import type { DbExecutor } from "@crm/db";

import type { TenantContext } from "../../tenant/context";
import { type loadActiveTicket, patchTicket } from "./actions";
import {
  messagePreviewText,
  updateConversationLastMessage,
  upsertConversationRead,
} from "./repository";

export type OutboundContent = OutboundMessage["content"];
export type ConversationRow = Awaited<ReturnType<typeof loadActiveTicket>>;

/** Preview, ticket → waiting_customer (assigns the caller, stamps first response once) and the author's read cursor. */
export async function recordAgentReply(
  tx: DbExecutor,
  ctx: TenantContext,
  {
    conversation,
    current,
    content,
    now,
  }: {
    conversation: ConversationRow;
    current: ConversationRow;
    content: OutboundContent;
    now: Date;
  },
): Promise<void> {
  await updateConversationLastMessage(tx, conversation.id, {
    lastMessageAt: now,
    lastMessage: {
      direction: "outbound",
      preview: messagePreviewText(content),
    },
  });
  await patchTicket(tx, ctx.organizationId, {
    conversationId: conversation.id,
    patch: {
      status: "waiting_customer",
      assigneeId: current.assigneeId ?? ctx.userId,
      firstResponseAt: current.firstResponseAt ?? now,
    },
  });
  // Sending implies the author saw the thread — bump their read cursor.
  await upsertConversationRead(tx, {
    organizationId: ctx.organizationId,
    conversationId: conversation.id,
    userId: ctx.userId,
  });
}
