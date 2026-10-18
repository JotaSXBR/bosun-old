import type { Database } from "@crm/db";
import { withTenant } from "@crm/db";

import { DomainError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import {
  listPendingGoogleSyncContacts,
  pageContactsForSync,
  summarizeGoogleSync,
} from "../contacts";
import { isEligible } from "./google-contact-map";
import { getGoogleStatus } from "./service";

export type GoogleSyncSummary = {
  eligible: number;
  synced: number;
  failed: number;
  lastSyncedAt: string | null;
};

/**
 * Requires integrations:read. One aggregate query: contacts the Google mirror
 * covers (coarse SQL form of `isEligible`), how many were sent, how many are
 * in error, and when the latest send happened.
 */
export function getGoogleSyncSummary(db: Database, ctx: TenantContext): Promise<GoogleSyncSummary> {
  assertPermission(ctx, { integrations: ["read"] });
  return withTenant(db, ctx.organizationId, (tx) => summarizeGoogleSync(tx, ctx.organizationId));
}

/**
 * Requires integrations:manage and a `connected` account. One page of
 * eligible contact ids; `next` is the cursor for the following page (null at
 * the end). The page limit bounds the contacts scanned, so a page may hold
 * fewer ids than `limit`.
 */
export async function listGoogleSyncContactIds(
  db: Database,
  ctx: TenantContext,
  options: { after?: string | undefined; limit: number },
): Promise<{ ids: string[]; next: string | null }> {
  assertPermission(ctx, { integrations: ["manage"] });
  if ((await getGoogleStatus(db, ctx))?.status !== "connected") {
    throw new DomainError("GOOGLE_NOT_CONNECTED", "Nenhuma conta Google conectada.");
  }
  const page = await withTenant(db, ctx.organizationId, (tx) =>
    pageContactsForSync(tx, ctx.organizationId, options),
  );
  return {
    ids: page.filter(isEligible).map((contact) => contact.id),
    next: page.length < options.limit ? null : page[page.length - 1]!.id,
  };
}

/**
 * System entry for the sweep (no user context): one page of eligible contact ids
 * that still need a Google send. The SQL filter is coarse; `isEligible` decides.
 */
export async function listPendingGoogleSyncContactIds(
  db: Database,
  organizationId: string,
  options: { after?: string | undefined; limit: number },
): Promise<{ ids: string[]; next: string | null }> {
  const page = await withTenant(db, organizationId, (tx) =>
    listPendingGoogleSyncContacts(tx, organizationId, options),
  );
  return {
    ids: page.filter(isEligible).map((contact) => contact.id),
    next: page.length < options.limit ? null : page[page.length - 1]!.id,
  };
}
