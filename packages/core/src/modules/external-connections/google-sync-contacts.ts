import type { Database } from "@crm/db";
import { withTenant } from "@crm/db";

import { DomainError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { pageContactsForSync } from "../contacts";
import { isEligible } from "./google-contact-map";
import { getGoogleStatus } from "./service";

const SCAN_PAGE = 500;

export type GoogleSyncSummary = {
  eligible: number;
  synced: number;
  lastSyncedAt: string | null;
};

const lastSyncedOf = (metadata: Record<string, unknown>): string | null => {
  const google = metadata.google as { lastSyncedAt?: unknown } | undefined;
  return typeof google?.lastSyncedAt === "string" ? google.lastSyncedAt : null;
};

/**
 * Requires integrations:read. How many contacts the Google mirror covers
 * (same `isEligible` rule the job applies), how many were already sent and
 * when the latest send happened. Scans the org's contacts page by page.
 */
export async function getGoogleSyncSummary(
  db: Database,
  ctx: TenantContext,
): Promise<GoogleSyncSummary> {
  assertPermission(ctx, { integrations: ["read"] });
  const summary: GoogleSyncSummary = { eligible: 0, synced: 0, lastSyncedAt: null };
  let after: string | undefined;
  for (;;) {
    const page = await withTenant(db, ctx.organizationId, (tx) =>
      pageContactsForSync(tx, ctx.organizationId, { after, limit: SCAN_PAGE }),
    );
    for (const contact of page) {
      if (!isEligible(contact)) continue;
      summary.eligible += 1;
      const syncedAt = lastSyncedOf(contact.metadata);
      if (!syncedAt) continue;
      summary.synced += 1;
      if (!summary.lastSyncedAt || syncedAt > summary.lastSyncedAt) summary.lastSyncedAt = syncedAt;
    }
    if (page.length < SCAN_PAGE) return summary;
    after = page[page.length - 1]!.id;
  }
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
