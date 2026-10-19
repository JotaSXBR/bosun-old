import type { DbExecutor } from "@crm/db";
import { emitDomainEvent } from "@crm/db";

import { NotFoundError } from "../../errors";
import type { ConversationRow } from "./repository";
import { updateConversationState } from "./repository";

export async function patchTicket(
  executor: DbExecutor,
  organizationId: string,
  {
    conversationId,
    patch,
  }: { conversationId: string; patch: Parameters<typeof updateConversationState>[2] },
): Promise<ConversationRow> {
  const conv = await updateConversationState(executor, conversationId, patch);
  if (!conv) throw new NotFoundError("Conversation", conversationId);
  await emitDomainEvent(executor, {
    type: "conversation.updated",
    organizationId,
    conversationId: conv.id,
    status: conv.status,
    assigneeId: conv.assigneeId,
    sectorId: conv.sectorId,
  });
  return conv;
}
