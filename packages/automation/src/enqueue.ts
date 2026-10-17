import type { DbExecutor } from "@crm/db";
import { sql } from "@crm/db";
import { createLogger } from "@crm/observability";
import { fromDrizzle } from "pg-boss";

import { getBoss, QUEUES, startJobs } from "./boss";
import type { ChannelReconcilePayload } from "./tasks/channel-messages-reconcile";
import type { ContactAvatarPayload } from "./tasks/contact-avatar";
import type { ContactGoogleSyncPayload } from "./tasks/contact-google-sync";
import type { GenerateDraftPayload } from "./tasks/generate-draft";
import type { ObserverAnalyzePayload } from "./tasks/observer-analyze";
import type { OrganizationOnboardingPayload } from "./tasks/organization-onboarding";
import type { ProcessChannelEventPayload } from "./tasks/process-channel-event";
import type { TranscribeAudioPayload } from "./tasks/transcribe-audio";

const logger = createLogger({ bindings: { component: "jobs" } });

/**
 * Enqueues a job inside the caller's transaction when `tx` is passed —
 * the job row commits or rolls back with the domain write, no outbox
 * needed. Without `tx` the send is post-commit best-effort.
 */
async function send(name: string, payload: object, tx?: DbExecutor): Promise<{ skipped: boolean }> {
  const boss = getBoss();
  if (!boss) {
    // Jobs layer not started — kick a lazy start so the process self-heals
    // (covers register() never running or a failed boot attempt; the
    // `starting` singleton in boss.ts dedupes concurrent kicks). This
    // enqueue is still skipped — webhook retries and the reconcile sweep
    // cover the gap. Callers must not fail on a missing queue.
    startJobs().catch(() => {});
    logger.warn("jobs not started; skipping enqueue", { queue: name });
    return { skipped: true };
  }
  await boss.send(name, payload, tx ? { db: fromDrizzle(tx, sql) } : undefined);
  return { skipped: false };
}

/**
 * Enqueues process-channel-event after a webhook event was persisted. Pass
 * the ingest transaction so the job row is atomic with the message write.
 */
export async function enqueueChannelEventProcessed(
  payload: ProcessChannelEventPayload,
  tx?: DbExecutor,
): Promise<{ skipped: boolean }> {
  return send(QUEUES.processChannelEvent, payload, tx);
}

/**
 * Enqueues a targeted channel reconcile — used right after a connection
 * goes live (post-commit best-effort). The periodic sweep is scheduled in
 * boss.ts and needs no enqueue.
 */
export async function enqueueChannelReconcile(
  payload: ChannelReconcilePayload,
): Promise<{ skipped: boolean }> {
  return send(QUEUES.channelReconcile, payload);
}

/**
 * Enqueues the onboarding job after organization creation (Better Auth owns
 * that transaction, so this send is post-commit best-effort by necessity).
 */
export async function enqueueOrganizationOnboarding(
  payload: OrganizationOnboardingPayload,
): Promise<{ skipped: boolean }> {
  return send(QUEUES.organizationOnboarding, payload);
}

/**
 * Enqueues the AI observer after a ticket resolves (pass `tx` so the job row
 * is atomic with the resolve write) or when a user clicks "analyze now"
 * (post-commit best-effort, no tx).
 */
export async function enqueueObserverAnalyze(
  payload: ObserverAnalyzePayload,
  tx?: DbExecutor,
): Promise<{ skipped: boolean }> {
  return send(QUEUES.observerAnalyze, payload, tx);
}

/**
 * Enqueues a draft generation for the composer buttons (post-commit
 * best-effort — a skipped send just means the card never appears; the
 * button stays clickable).
 */
export async function enqueueGenerateDraft(
  payload: GenerateDraftPayload,
  tx?: DbExecutor,
): Promise<{ skipped: boolean }> {
  return send(QUEUES.generateDraft, payload, tx);
}

/**
 * Enqueues a contact-avatar fetch — called from ingest with the tx so the
 * job commits atomically with the message write.
 */
export async function enqueueContactAvatar(
  payload: ContactAvatarPayload,
  tx?: DbExecutor,
): Promise<{ skipped: boolean }> {
  return send(QUEUES.contactAvatar, payload, tx);
}

/**
 * Enqueues an audio transcription — called from ingest with the tx so the
 * job commits atomically with the message write. The handler is a no-op
 * without an audio-capable BYOK credential.
 */
export async function enqueueTranscribeAudio(
  payload: TranscribeAudioPayload,
  tx?: DbExecutor,
): Promise<{ skipped: boolean }> {
  return send(QUEUES.transcribeAudio, payload, tx);
}

/**
 * Enqueues a Google mirror of one contact. The `singletonKey` makes the
 * `key_strict_fifo` queue run one job at a time per organization (the
 * People API wants sequential mutations per account).
 */
export async function enqueueContactGoogleSync(
  payload: ContactGoogleSyncPayload,
  tx?: DbExecutor,
): Promise<{ skipped: boolean }> {
  const boss = getBoss();
  if (!boss) {
    startJobs().catch(() => {});
    logger.warn("jobs not started; skipping enqueue", { queue: QUEUES.contactGoogleSync });
    return { skipped: true };
  }
  await boss.send(QUEUES.contactGoogleSync, payload, {
    singletonKey: `google:${payload.organizationId}`,
    // A job past this limit lands in `failed`, which holds the org's key; the
    // default (15 min) would stall the org for that long. A client call
    // (4 attempts, 15 s each + backoff) fits well inside it.
    // shortcut: no sweep for `failed` jobs, add one if a stuck key is ever seen.
    expireInSeconds: 120,
    retryLimit: 0,
    ...(tx ? { db: fromDrizzle(tx, sql) } : {}),
  });
  return { skipped: false };
}
