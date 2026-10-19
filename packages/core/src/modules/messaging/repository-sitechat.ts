import type { DbExecutor } from "@crm/db";
import { schema } from "@crm/db";
import { eq } from "drizzle-orm";

import type { ChannelConnectionRow, ContactRow } from "./repository";

const { channelConnections, contacts, siteChatSessions } = schema;

export type SiteChatSessionRow = typeof siteChatSessions.$inferSelect;

/**
 * Service-scope session lookup for the public widget endpoints — the token
 * is the only authentication, so this intentionally bypasses tenant
 * scoping (call inside withServiceAccess).
 */
export async function findSiteChatSessionByToken(
  executor: DbExecutor,
  token: string,
): Promise<
  | {
      session: SiteChatSessionRow;
      contact: ContactRow;
      connection: ChannelConnectionRow;
    }
  | undefined
> {
  const [row] = await executor
    .select({
      session: siteChatSessions,
      contact: contacts,
      connection: channelConnections,
    })
    .from(siteChatSessions)
    .innerJoin(contacts, eq(siteChatSessions.contactId, contacts.id))
    .innerJoin(channelConnections, eq(siteChatSessions.channelConnectionId, channelConnections.id))
    .where(eq(siteChatSessions.token, token))
    .limit(1);
  return row;
}

export async function insertSiteChatSession(
  executor: DbExecutor,
  values: {
    organizationId: string;
    channelConnectionId: string;
    contactId: string;
    token: string;
  },
): Promise<SiteChatSessionRow> {
  const [row] = await executor.insert(siteChatSessions).values(values).returning();
  if (!row) throw new Error("site_chat_sessions insert returned no row");
  return row;
}

export async function touchSiteChatSession(executor: DbExecutor, id: string): Promise<void> {
  await executor
    .update(siteChatSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(siteChatSessions.id, id));
}
