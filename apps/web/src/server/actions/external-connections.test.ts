import { beforeEach, describe, expect, it, vi } from "vitest";

const enableGoogleAutoSync = vi.hoisted(() =>
  vi.fn<(db: unknown, ctx: unknown) => Promise<void>>(),
);
const enqueueContactGoogleSweep = vi.hoisted(() =>
  vi.fn<(payload: { organizationId: string }) => Promise<{ skipped: boolean }>>(),
);
const revalidatePath = vi.hoisted(() => vi.fn());
const ctx = vi.hoisted(() => ({ organizationId: "org-from-session", role: "admin" }));

vi.mock("@crm/automation", () => ({ enqueueContactGoogleSweep }));
vi.mock("@crm/core", () => {
  class DomainError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { DomainError };
});
vi.mock("@crm/core/external-connections", () => ({
  disconnectGoogle: vi.fn(),
  enableGoogleAutoSync,
  saveGoogleClient: vi.fn(),
  verifyGoogleConnection: vi.fn(),
}));
vi.mock("@crm/db", () => ({ getDb: () => ({}) }));
vi.mock("@crm/observability", () => ({ captureException: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/app/api/integrations/google/redirect", () => ({ googleRedirectUri: () => "" }));
vi.mock("@/server/tenant", () => ({ requireTenantContext: () => Promise.resolve(ctx) }));

import { syncGoogleContactsAction } from "./external-connections";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 10 * 60_000 * ++run); // clear the per-org cooldown between tests
  enableGoogleAutoSync.mockReset();
  enqueueContactGoogleSweep.mockReset();
  revalidatePath.mockReset();
  enableGoogleAutoSync.mockResolvedValue();
  enqueueContactGoogleSweep.mockResolvedValue({ skipped: false });
});

let run = 0;

describe("syncGoogleContactsAction", () => {
  it("records consent and queues a sweep for the session's organization", async () => {
    await expect(syncGoogleContactsAction()).resolves.toEqual({ ok: true, queued: 0 });

    expect(enableGoogleAutoSync).toHaveBeenCalledOnce();
    expect(enqueueContactGoogleSweep).toHaveBeenCalledWith({ organizationId: "org-from-session" });
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("rejects a repeat request inside the cooldown without enqueueing again", async () => {
    await syncGoogleContactsAction();
    enqueueContactGoogleSweep.mockClear();

    const result = await syncGoogleContactsAction();

    expect(result.ok).toBe(false);
    expect(enqueueContactGoogleSweep).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61_000);
    await expect(syncGoogleContactsAction()).resolves.toMatchObject({ ok: true });
  });

  it("reports an unavailable queue instead of claiming success", async () => {
    enqueueContactGoogleSweep.mockResolvedValue({ skipped: true });
    await expect(syncGoogleContactsAction()).resolves.toEqual({
      ok: false,
      error: "A fila não está disponível.",
    });
  });

  it("returns the domain error instead of throwing, and queues nothing (e.g. Google not connected)", async () => {
    const { DomainError } = await import("@crm/core");
    enableGoogleAutoSync.mockRejectedValue(
      new DomainError("GOOGLE_NOT_CONNECTED", "Nenhuma conta Google conectada."),
    );
    await expect(syncGoogleContactsAction()).resolves.toEqual({
      ok: false,
      error: "Nenhuma conta Google conectada.",
    });
    expect(enqueueContactGoogleSweep).not.toHaveBeenCalled();
  });
});
