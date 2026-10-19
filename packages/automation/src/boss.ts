import type { ServerEnv } from "@crm/config";
import { getServerEnv } from "@crm/config";
import { createLogger } from "@crm/observability";
import { PgBoss } from "pg-boss";

import { brainStaleSweepHandler } from "./tasks/brain-stale-sweep";
import { channelReconcileHandler } from "./tasks/channel-messages-reconcile";
import { closeResolvedTicketsHandler } from "./tasks/close-resolved-tickets";
import { contactAvatarHandler } from "./tasks/contact-avatar";
import { contactGoogleSweepHandler } from "./tasks/contact-google-sweep";
import { contactGoogleSyncHandler } from "./tasks/contact-google-sync";
import { generateDraftHandler } from "./tasks/generate-draft";
import { observerAnalyzeHandler } from "./tasks/observer-analyze";
import { observerScanHandler } from "./tasks/observer-scan";
import { organizationOnboardingHandler } from "./tasks/organization-onboarding";
import { processChannelEventHandler } from "./tasks/process-channel-event";
import { transcribeAudioHandler } from "./tasks/transcribe-audio";

const logger = createLogger({ bindings: { component: "jobs" } });

export const QUEUES = {
  processChannelEvent: "process-channel-event",
  organizationOnboarding: "organization-onboarding",
  closeResolvedTickets: "close-resolved-tickets",
  channelReconcile: "channel-messages-reconcile",
  observerAnalyze: "observer-analyze",
  brainStaleSweep: "brain-stale-sweep",
  generateDraft: "generate-draft",
  observerScan: "observer-scan",
  contactAvatar: "contact-avatar",
  transcribeAudio: "transcribe-audio",
  contactGoogleSync: "contact-google-sync",
  contactGoogleSweep: "contact-google-sweep",
} as const;

let boss: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

/**
 * pg-boss runs in-process in the web server (started by instrumentation
 * `register()` on the nodejs runtime only). Its schema lives in `pgboss`,
 * created by migration 0009 as the owner role — the app connects as
 * `crm_app`, so `migrate`/`createSchema` stay off and `boss.start()` only
 * verifies the schema version.
 */
const START_TIMEOUT_MS = 15_000;

export async function startJobs(env: ServerEnv = getServerEnv()): Promise<PgBoss> {
  if (boss) return boss;
  // A rejected/stalled attempt must not poison every future call — clear
  // `starting` so the next enqueue retries. The timeout covers a hung
  // start() (e.g. advisory-lock wait), which otherwise kills the jobs
  // layer forever with no signal.
  starting ??= Promise.race([
    start(env),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`pg-boss start timed out after ${START_TIMEOUT_MS}ms`)),
        START_TIMEOUT_MS,
      ).unref(),
    ),
  ]).catch((error: unknown) => {
    starting = undefined;
    logger.error("pg-boss start failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  });
  return starting;
}

type Handler = (payload: unknown) => Promise<unknown>;

const WORKERS: Array<[queue: string, handler: Handler]> = [
  [QUEUES.processChannelEvent, processChannelEventHandler],
  [QUEUES.organizationOnboarding, organizationOnboardingHandler],
  [QUEUES.closeResolvedTickets, closeResolvedTicketsHandler],
  [QUEUES.channelReconcile, channelReconcileHandler],
  [QUEUES.observerAnalyze, observerAnalyzeHandler],
  [QUEUES.brainStaleSweep, brainStaleSweepHandler],
  [QUEUES.generateDraft, generateDraftHandler],
  [QUEUES.observerScan, observerScanHandler],
  [QUEUES.contactAvatar, contactAvatarHandler],
  [QUEUES.transcribeAudio, transcribeAudioHandler],
  [QUEUES.contactGoogleSync, contactGoogleSyncHandler],
  [QUEUES.contactGoogleSweep, contactGoogleSweepHandler],
];

const SCHEDULES: Array<[queue: string, cron: string]> = [
  // Resolved tickets past the reopen window.
  [QUEUES.closeResolvedTickets, "*/15 * * * *"],
  // Backfill messages WAHA received while the stack was down — the webhook
  // retry window only covers short outages.
  [QUEUES.channelReconcile, "*/30 * * * *"],
  // Mirror contacts the Google account is behind on (orgs that consented only).
  [QUEUES.contactGoogleSweep, "*/10 * * * *"],
  // Interval-mode observer sweep — the per-org cadence lives in
  // organization_settings.observer_interval_minutes; the cron tick is just
  // the polling granularity.
  [QUEUES.observerScan, "*/5 * * * *"],
  // Flag expired canon memory entries for human review once a day.
  [QUEUES.brainStaleSweep, "15 3 * * *"],
];

async function registerWorkers(instance: PgBoss): Promise<void> {
  for (const [queue, handler] of WORKERS) {
    await instance.work(queue, async (jobs) => {
      for (const job of jobs) await handler(job.data);
    });
  }
}

async function registerSchedules(instance: PgBoss): Promise<void> {
  for (const [queue, cron] of SCHEDULES) await instance.schedule(queue, cron);
}

async function start(env: ServerEnv): Promise<PgBoss> {
  logger.info("pg-boss starting");
  const instance = new PgBoss({
    connectionString: env.database.url,
    schema: "pgboss",
    migrate: false,
    createSchema: false,
    application_name: "crm-jobs",
  });
  instance.on("error", (error: Error) => {
    logger.error("pg-boss error", { error: error.message });
  });
  await instance.start();

  for (const name of Object.values(QUEUES)) {
    // partition:false — all queues share the job_common partition, so this
    // only inserts a row in pgboss.queue (crm_app needs no CREATE SCHEMA).
    // Google allows one mutation at a time per account, so that queue runs
    // strictly one job per singletonKey (`google:<organizationId>`).
    await instance.createQueue(
      name,
      name === QUEUES.contactGoogleSync ? { policy: "key_strict_fifo" } : undefined,
    );
  }
  await registerWorkers(instance);
  await registerSchedules(instance);

  logger.info("pg-boss started", { queues: Object.values(QUEUES) });
  return (boss = instance);
}

/** The started singleton — undefined until `startJobs()` resolves (tests, edge). */
export function getBoss(): PgBoss | undefined {
  return boss;
}

export async function stopJobs(): Promise<void> {
  const instance = boss;
  boss = undefined;
  starting = undefined;
  await instance?.stop();
}
