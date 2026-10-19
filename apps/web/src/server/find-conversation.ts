import type { TenantContext } from "@crm/core";
import { NotFoundError } from "@crm/core";

import { getConversation } from "@/server/services";

/** The conversation, or null when it does not exist (or belongs to another organization). */
export async function findConversation(ctx: TenantContext, conversationId: string) {
  try {
    return await getConversation(ctx, conversationId);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}
