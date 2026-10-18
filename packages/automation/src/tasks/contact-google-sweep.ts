import {
  isGoogleAutoSyncActive,
  listGoogleAutoSyncOrganizationIds,
  listPendingGoogleSyncContactIds,
  markGoogleSweepAt,
} from "@crm/core/external-connections";
import { getDb } from "@crm/db";
import { createLogger } from "@crm/observability";
import { z } from "zod";

import { enqueueContactGoogleSync } from "../enqueue";

const logger = createLogger({ bindings: { component: "contact-google-sweep" } });

export const contactGoogleSweepPayload = z.object({ organizationId: z.uuid().optional() });

export type ContactGoogleSweepPayload = z.infer<typeof contactGoogleSweepPayload>;

const PAGE_SIZE = 200;
// shortcut: per-org cap per run; a bigger backlog drains over the next ticks, raise if sweeps lag.
const MAX_PER_ORG = 500;

/**
 * Enqueues a sync job for every contact the Google mirror is behind on
 * (never tried, edited since, or failed over an hour ago). Runs for the one org
 * in the payload (the "Sincronizar agora" button) or, from the cron, for every
 * org that consented to automatic sync. Always completes: one broken org must
 * not stop the others.
 */
export async function contactGoogleSweepHandler(
  payload: unknown,
): Promise<{ orgs: number; queued: number }> {
  const parsed = contactGoogleSweepPayload.safeParse(payload ?? {});
  const db = getDb();
  const totals = { orgs: 0, queued: 0 };
  let organizationIds: string[];
  try {
    organizationIds = parsed.success
      ? parsed.data.organizationId
        ? [parsed.data.organizationId]
        : await listGoogleAutoSyncOrganizationIds(db)
      : [];
  } catch (error) {
    logger.warn("contact-google-sweep: listing orgs failed", { error: errorName(error) });
    return totals;
  }
  for (const organizationId of organizationIds) {
    try {
      if (!(await isGoogleAutoSyncActive(db, organizationId))) continue;
      totals.orgs += 1;
      totals.queued += await sweepOrganization(organizationId);
    } catch (error) {
      logger.warn("contact-google-sweep failed for org", {
        organizationId,
        error: errorName(error),
      });
    }
  }
  return totals;
}

async function sweepOrganization(organizationId: string): Promise<number> {
  const db = getDb();
  let queued = 0;
  let after: string | undefined;
  while (queued < MAX_PER_ORG) {
    const page = await listPendingGoogleSyncContactIds(db, organizationId, {
      after,
      limit: PAGE_SIZE,
    });
    for (const contactId of page.ids) {
      if (queued >= MAX_PER_ORG) break;
      const { skipped } = await enqueueContactGoogleSync({ organizationId, contactId });
      if (skipped) return queued; // jobs layer down: the next tick retries
      queued += 1;
    }
    if (!page.next) break;
    after = page.next;
  }
  await markGoogleSweepAt(db, organizationId);
  return queued;
}

// Drizzle errors embed SQL params (contact data): log only the class.
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");
