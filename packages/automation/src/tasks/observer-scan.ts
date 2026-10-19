import { hasOrgLlmCredentials } from "@crm/core/ai";
import {
  createNudgeSuggestion,
  listNudgeCandidates,
  listStaleNudges,
  supersedeNudges,
} from "@crm/core/drafts";
import type { ObserverScanOrg } from "@crm/core/organizations";
import { listObserverScanDue, markObserverScanAt } from "@crm/core/organizations";
import type { Database } from "@crm/db";
import { getDb, withServiceAccess, withTenant } from "@crm/db";
import { createLogger } from "@crm/observability";
import { z } from "zod";

import { enqueueGenerateDraft } from "../enqueue";

const logger = createLogger({ bindings: { component: "observer-scan" } });

export const observerScanPayload = z.object({}).loose();

export type ObserverScanDeps = {
  /** Injectable for tests — defaults to the real queue enqueue. */
  enqueueDraft?: typeof enqueueGenerateDraft;
};

type ScanCounts = { nudges: number; drafts: number; cleaned: number };
type ScanContext = { db: Database; org: ObserverScanOrg; deps: ObserverScanDeps | undefined };

function addCounts(total: ScanCounts, add: ScanCounts) {
  total.nudges += add.nudges;
  total.drafts += add.drafts;
  total.cleaned += add.cleaned;
}

/**
 * Interval-mode observer (docs/product/ai-agents.md): deterministic scan —
 * NO LLM call here. For each due org (mode='interval', per-org cadence
 * elapsed) it finds open/assigned tickets whose last message is inbound
 * and older than the idle threshold, then drops a nudge card in the
 * thread — or enqueues the drafter when `observer_auto_draft` upgrades the
 * org. Orgs without a BYOK credential are skipped silently. Pending nudges
 * whose predicate stopped holding are superseded by the cleanup pass.
 */
export async function observerScanHandler(
  payload: unknown,
  deps?: ObserverScanDeps,
): Promise<{ scanned: number } & ScanCounts> {
  observerScanPayload.parse(payload);
  const db = getDb();
  const due = await withServiceAccess(db, (tx) => listObserverScanDue(tx));
  const totals = { scanned: 0, nudges: 0, drafts: 0, cleaned: 0 };
  for (const org of due) {
    totals.scanned += 1;
    try {
      addCounts(totals, await scanOrganization(db, org, deps));
    } catch (error) {
      // One broken org must not kill the sweep — its cadence watermark
      // already advanced, so it retries on its own schedule, not the
      // cron's 5-minute tick.
      logger.warn("observer scan failed for org", {
        organizationId: org.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return totals;
}

async function scanOrganization(
  db: Database,
  org: ObserverScanOrg,
  deps?: ObserverScanDeps,
): Promise<ScanCounts> {
  const { organizationId } = org;
  // The watermark advances even when the org can't run — a missing
  // credential or a mid-scan failure shouldn't re-scan every cron tick.
  await withTenant(db, organizationId, (tx) => markObserverScanAt(tx, organizationId));
  const configured = await withTenant(db, organizationId, (tx) =>
    hasOrgLlmCredentials(tx, organizationId),
  );
  if (!configured) return { nudges: 0, drafts: 0, cleaned: 0 };

  const cleaned = await supersedeStaleNudges(db, organizationId);
  const candidates = await withTenant(db, organizationId, (tx) =>
    listNudgeCandidates(tx, organizationId, {
      idleMinutes: org.idleMinutes,
      cooldownMinutes: org.idleMinutes,
    }),
  );
  const acted = await actOnCandidates({ db, org, deps }, candidates);
  return { ...acted, cleaned };
}

async function supersedeStaleNudges(db: Database, organizationId: string): Promise<number> {
  return withTenant(db, organizationId, async (tx) => {
    const stale = await listStaleNudges(tx, organizationId);
    await supersedeNudges(
      tx,
      organizationId,
      stale.map((s) => s.id),
    );
    return stale.length;
  });
}

async function actOnCandidates(
  ctx: ScanContext,
  candidates: { id: string }[],
): Promise<{ nudges: number; drafts: number }> {
  const counts = { nudges: 0, drafts: 0 };
  for (const candidate of candidates) {
    const kind = await actOnCandidate(ctx, candidate.id);
    if (kind) counts[kind] += 1;
  }
  return counts;
}

/** Enqueues the drafter when the org auto-drafts, else drops a nudge card; null = nothing happened. */
async function actOnCandidate(
  { db, org, deps }: ScanContext,
  conversationId: string,
): Promise<"nudges" | "drafts" | null> {
  const { organizationId } = org;
  if (org.autoDraft) {
    // The drafter job re-checks credentials and supersedes any card that
    // landed meanwhile — a skipped enqueue just means no card this cycle.
    const enqueueDraft = deps?.enqueueDraft ?? enqueueGenerateDraft;
    const enqueued = await enqueueDraft({ organizationId, conversationId, mode: "suggest" });
    return enqueued.skipped ? null : "drafts";
  }
  await createNudgeSuggestion(db, organizationId, {
    conversationId,
    rationale: `Cliente aguardando resposta há ${org.idleMinutes}+ min`,
    idleMinutes: org.idleMinutes,
  });
  return "nudges";
}
