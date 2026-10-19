import type { ServerEnv } from "@crm/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

// pg-boss and every task module are faked: this pins the wiring in boss.ts
// (which queue runs which handler, which crons exist), not the handlers.
const fake = vi.hoisted(() => ({
  instance: {
    on: vi.fn(),
    start: vi.fn(),
    createQueue: vi.fn(),
    work: vi.fn(),
    schedule: vi.fn(),
  },
}));

vi.mock("pg-boss", () => ({
  PgBoss: vi.fn(function PgBoss() {
    return fake.instance;
  }),
}));
vi.mock("./tasks/brain-stale-sweep", () => ({ brainStaleSweepHandler: vi.fn() }));
vi.mock("./tasks/channel-messages-reconcile", () => ({ channelReconcileHandler: vi.fn() }));
vi.mock("./tasks/close-resolved-tickets", () => ({ closeResolvedTicketsHandler: vi.fn() }));
vi.mock("./tasks/contact-avatar", () => ({ contactAvatarHandler: vi.fn() }));
vi.mock("./tasks/contact-google-sweep", () => ({ contactGoogleSweepHandler: vi.fn() }));
vi.mock("./tasks/contact-google-sync", () => ({ contactGoogleSyncHandler: vi.fn() }));
vi.mock("./tasks/generate-draft", () => ({ generateDraftHandler: vi.fn() }));
vi.mock("./tasks/observer-analyze", () => ({ observerAnalyzeHandler: vi.fn() }));
vi.mock("./tasks/observer-scan", () => ({ observerScanHandler: vi.fn() }));
vi.mock("./tasks/organization-onboarding", () => ({ organizationOnboardingHandler: vi.fn() }));
vi.mock("./tasks/process-channel-event", () => ({ processChannelEventHandler: vi.fn() }));
vi.mock("./tasks/transcribe-audio", () => ({ transcribeAudioHandler: vi.fn() }));

const env = { database: { url: "postgres://fake" } } as ServerEnv;

async function boot() {
  vi.resetModules();
  const { startJobs, QUEUES } = await import("./boss");
  await startJobs(env);
  return QUEUES;
}

/** The handler registered for a queue, as pg-boss would call it with a batch. */
function workerFor(queue: string) {
  const call = fake.instance.work.mock.calls.find(([name]) => name === queue);
  return call?.[1] as ((jobs: Array<{ data: unknown }>) => Promise<void>) | undefined;
}

describe("startJobs wiring", () => {
  beforeEach(() => {
    for (const fn of Object.values(fake.instance)) fn.mockReset();
    fake.instance.start.mockResolvedValue(undefined);
  });

  it("creates every queue, and only the Google sync queue is key_strict_fifo", async () => {
    const QUEUES = await boot();
    const created = fake.instance.createQueue.mock.calls;
    expect(created.map(([name]) => name).sort()).toEqual(Object.values(QUEUES).sort());
    for (const [name, options] of created) {
      expect(options).toEqual(
        name === QUEUES.contactGoogleSync ? { policy: "key_strict_fifo" } : undefined,
      );
    }
  });

  it("registers exactly one worker per queue", async () => {
    const QUEUES = await boot();
    const queues = fake.instance.work.mock.calls.map(([name]) => name);
    expect([...queues].sort()).toEqual(Object.values(QUEUES).sort());
    expect(new Set(queues).size).toBe(queues.length);
  });

  it("feeds each job's data to the queue's own handler, once per job", async () => {
    const QUEUES = await boot();
    const sync = (await import("./tasks/contact-google-sync")) as unknown as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    const sweep = (await import("./tasks/contact-google-sweep")) as unknown as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    await workerFor(QUEUES.contactGoogleSync)!([{ data: { a: 1 } }, { data: { a: 2 } }]);
    expect(sync.contactGoogleSyncHandler).toHaveBeenCalledTimes(2);
    expect(sync.contactGoogleSyncHandler).toHaveBeenNthCalledWith(1, { a: 1 });
    expect(sync.contactGoogleSyncHandler).toHaveBeenNthCalledWith(2, { a: 2 });
    expect(sweep.contactGoogleSweepHandler).not.toHaveBeenCalled();
  });

  it("schedules exactly the five periodic sweeps", async () => {
    const QUEUES = await boot();
    expect(fake.instance.schedule.mock.calls).toEqual([
      [QUEUES.closeResolvedTickets, "*/15 * * * *"],
      [QUEUES.channelReconcile, "*/30 * * * *"],
      [QUEUES.contactGoogleSweep, "*/10 * * * *"],
      [QUEUES.observerScan, "*/5 * * * *"],
      [QUEUES.brainStaleSweep, "15 3 * * *"],
    ]);
  });
});
