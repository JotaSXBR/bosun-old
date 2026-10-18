import {
  isGoogleAutoSyncActive,
  listGoogleAutoSyncOrganizationIds,
  listPendingGoogleSyncContactIds,
  markGoogleSweepAt,
} from "@crm/core/external-connections";
import { getDb } from "@crm/db";
import { createLogger } from "@crm/observability";
import { z } from "zod";

import { clearFailedGoogleSyncJobs, enqueueContactGoogleSync } from "../enqueue";

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
  const db = getDb();
  const totals = { orgs: 0, queued: 0 };
  for (const organizationId of await targetOrganizations(payload)) {
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

/** The payload's org, or every org that consented; an unusable payload or listing sweeps nothing. */
async function targetOrganizations(payload: unknown): Promise<string[]> {
  const parsed = contactGoogleSweepPayload.safeParse(payload ?? {});
  if (!parsed.success) return [];
  if (parsed.data.organizationId) return [parsed.data.organizationId];
  try {
    return await listGoogleAutoSyncOrganizationIds(getDb());
  } catch (error) {
    logger.warn("contact-google-sweep: listing orgs failed", { error: errorName(error) });
    return [];
  }
}

async function sweepOrganization(organizationId: string): Promise<number> {
  await clearFailedGoogleSyncJobs(organizationId);
  const { queued, stopped } = await enqueuePending(organizationId);
  if (!stopped) await markGoogleSweepAt(getDb(), organizationId);
  return queued;
}

/** Pages through the pending contacts up to the per-run cap; `stopped` = jobs layer down. */
async function enqueuePending(
  organizationId: string,
): Promise<{ queued: number; stopped: boolean }> {
  let queued = 0;
  let after: string | null | undefined;
  while (queued < MAX_PER_ORG && after !== null) {
    const page = await sweepPage(organizationId, after, MAX_PER_ORG - queued);
    queued += page.queued;
    if (page.stopped) return { queued, stopped: true }; // the next tick retries
    after = page.next;
  }
  return { queued, stopped: false };
}

async function sweepPage(organizationId: string, after: string | undefined, budget: number) {
  const page = await listPendingGoogleSyncContactIds(getDb(), organizationId, {
    after,
    limit: PAGE_SIZE,
  });
  let queued = 0;
  for (const contactId of page.ids.slice(0, budget)) {
    const { skipped } = await enqueueContactGoogleSync({ organizationId, contactId });
    if (skipped) return { queued, next: page.next, stopped: true };
    queued += 1;
  }
  return { queued, next: page.next, stopped: false };
}

// Drizzle errors embed SQL params (contact data): log only the class.
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");
