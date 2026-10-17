import type { DbExecutor } from "@crm/db";
import { schema } from "@crm/db";
import { and, asc, eq, gt, sql } from "drizzle-orm";

import type { UpdateContactProfileInput } from "./schemas";

const { contacts, conversations } = schema;

export type ContactRow = typeof contacts.$inferSelect;

export type ContactListRow = Pick<
  ContactRow,
  "id" | "channelUserId" | "displayName" | "metadata" | "createdAt"
> & { conversationCount: number };

/**
 * Manual contact insert — unlike the ingest-time upsert, a name the agent
 * typed always wins over the stored one. Returns the row (existing or new).
 */
export async function insertOrGetContact(
  executor: DbExecutor,
  organizationId: string,
  values: {
    channelUserId: string;
    displayName: string;
    metadata?: Record<string, unknown> | undefined;
  },
): Promise<ContactRow> {
  const [row] = await executor
    .insert(contacts)
    .values({
      organizationId,
      channelUserId: values.channelUserId,
      displayName: values.displayName,
      metadata: values.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [contacts.organizationId, contacts.channelUserId],
      set: {
        displayName: values.displayName,
        metadata: sql`${contacts.metadata} || excluded.metadata`,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("contacts insert returned no row");
  return row;
}

/** Tenant-scoped contact lookup (call inside withTenant). */
export async function findContactById(
  executor: DbExecutor,
  contactId: string,
): Promise<ContactRow | undefined> {
  const [row] = await executor.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  return row;
}

const PROFILE_KEYS = [
  "email",
  "phone",
  "notes",
  "company",
  "jobTitle",
  "address",
  "birthday",
  "urls",
] as const;

/**
 * Ficha edit — `displayName` column update plus a metadata jsonb patch for
 * the profile keys; an empty string / empty list removes the key.
 */
export async function updateContactProfileRow(
  executor: DbExecutor,
  contactId: string,
  values: Omit<UpdateContactProfileInput, "contactId">,
): Promise<void> {
  const patch: Record<string, string | string[]> = {};
  const drops: string[] = [];
  for (const key of PROFILE_KEYS) {
    const value = values[key];
    if (value === undefined) continue;
    if (value === "" || (Array.isArray(value) && value.length === 0)) drops.push(key);
    else patch[key] = value;
  }
  // `jsonb - text` removes a key; `||` merges the patch — bound params keep
  // this parameterized (keys are compile-time constants from the loop above).
  let metaExpr = sql`${contacts.metadata}`;
  for (const key of drops) metaExpr = sql`${metaExpr} - ${key}`;
  metaExpr = sql`${metaExpr} || ${JSON.stringify(patch)}::jsonb`;
  await executor
    .update(contacts)
    .set({
      ...(values.displayName !== undefined ? { displayName: values.displayName } : {}),
      ...(drops.length > 0 || Object.keys(patch).length > 0 ? { metadata: metaExpr } : {}),
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));
}

/**
 * Records the avatar fetch result: proxy URL + storage key on success,
 * `avatarFetchedAt` either way — the stamp is what throttles heal
 * attempts on later inbound messages.
 */
export async function updateContactAvatar(
  executor: DbExecutor,
  contactId: string,
  values: { avatarUrl?: string; avatarKey?: string },
): Promise<void> {
  const fetchedAt = new Date().toISOString();
  const patch =
    values.avatarUrl && values.avatarKey
      ? { avatarKey: values.avatarKey, avatarFetchedAt: fetchedAt }
      : { avatarFetchedAt: fetchedAt };
  await executor
    .update(contacts)
    .set({
      ...(values.avatarUrl ? { avatarUrl: values.avatarUrl } : {}),
      metadata: sql`${contacts.metadata} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));
}

/**
 * Stores the Google mirror state under `metadata.google`. Deliberately leaves
 * `updated_at` alone — a sync is not a user edit.
 */
export async function updateContactGoogleSync(
  executor: DbExecutor,
  organizationId: string,
  contactId: string,
  google: Record<string, unknown>,
): Promise<void> {
  await executor
    .update(contacts)
    .set({ metadata: sql`${contacts.metadata} || ${JSON.stringify({ google })}::jsonb` })
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, organizationId)));
}

/** Keyset page of contacts (ordered by id) for the Google sync scan — call inside withTenant. */
export async function pageContactsForSync(
  executor: DbExecutor,
  organizationId: string,
  options: { after?: string | undefined; limit: number },
): Promise<Pick<ContactRow, "id" | "channelUserId" | "displayName" | "metadata">[]> {
  return executor
    .select({
      id: contacts.id,
      channelUserId: contacts.channelUserId,
      displayName: contacts.displayName,
      metadata: contacts.metadata,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, organizationId),
        options.after ? gt(contacts.id, options.after) : undefined,
      ),
    )
    .orderBy(contacts.id)
    .limit(options.limit);
}

/**
 * Contacts page rows — one row per contact with the count of tickets it
 * ever had, name/id search, alphabetical order. The count comes from a
 * grouped LEFT JOIN (single scan), not a per-row correlated subquery —
 * conversations.contact_id has no index, so a subplan would seq-scan the
 * whole table once per contact row.
 */
export async function listContacts(
  executor: DbExecutor,
  organizationId: string,
  options: { query?: string | undefined; limit: number; offset: number },
): Promise<ContactListRow[]> {
  const pattern = `%${(options.query ?? "").replace(/[%_\\]/g, "")}%`;
  return executor
    .select({
      id: contacts.id,
      channelUserId: contacts.channelUserId,
      displayName: contacts.displayName,
      metadata: contacts.metadata,
      createdAt: contacts.createdAt,
      conversationCount: sql<number>`count(${conversations.id})::int`,
    })
    .from(contacts)
    .leftJoin(conversations, eq(conversations.contactId, contacts.id))
    .where(
      and(
        eq(contacts.organizationId, organizationId),
        options.query
          ? sql`(${contacts.displayName} ilike ${pattern} or ${contacts.channelUserId} ilike ${pattern})`
          : undefined,
      ),
    )
    .groupBy(contacts.id)
    .orderBy(asc(contacts.displayName), asc(contacts.channelUserId))
    .limit(options.limit)
    .offset(options.offset);
}
