import type { DbExecutor } from "@crm/db";
import { schema } from "@crm/db";
import { eq, sql } from "drizzle-orm";

const { conversations, messages } = schema;

/**
 * One-line inbox preview for a stored message — mirrors the SQL coalesce
 * the denormalized column replaces: text ?? caption ?? "[type]".
 */
export function messagePreviewText(content: unknown): string {
  const c = content as { type?: string; text?: string; caption?: string } | null;
  return c?.text ?? c?.caption ?? `[${c?.type ?? "unknown"}]`;
}

/**
 * Bumps the conversation's last-message marker AND its denormalized
 * preview/direction — every caller writes them together so the inbox
 * list never needs a correlated probe into messages. Only non-private
 * message paths call this: internal notes must not leak into the queue
 * preview nor clear the awaiting-reply flag.
 */
export async function updateConversationLastMessage(
  executor: DbExecutor,
  conversationId: string,
  {
    lastMessageAt,
    lastMessage,
  }: { lastMessageAt: Date; lastMessage: { direction: string; preview: string } },
): Promise<void> {
  await executor
    .update(conversations)
    .set({
      lastMessageAt,
      lastMessagePreview: lastMessage.preview,
      lastMessageDirection: lastMessage.direction,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));
}

/**
 * Recomputes the denormalized preview/direction after a rare mutation —
 * edit or revoke of the conversation's latest message. One correlated
 * UPDATE on a path that already pays a provider call; NOT for list reads.
 * Revoked messages keep their content (same semantics as the old subplan).
 */
export async function refreshConversationLastMessage(
  executor: DbExecutor,
  conversationId: string,
): Promise<void> {
  await executor.execute(sql`
    update ${conversations} c
    set last_message_preview = m.preview,
        last_message_direction = m.direction,
        updated_at = now()
    from (
      select coalesce(content ->> 'text', content ->> 'caption', '[' || (content ->> 'type') || ']') as preview,
             direction
      from ${messages}
      where conversation_id = ${conversationId}
        and "private" is not true
      order by sent_at desc nulls last, created_at desc
      limit 1
    ) m
    where c.id = ${conversationId}
  `);
}
