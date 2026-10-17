import { beforeEach, describe, expect, it, vi } from "vitest";

const listGoogleSyncContactIds = vi.hoisted(() =>
  vi.fn<
    (
      db: unknown,
      ctx: unknown,
      options: { after?: string | undefined; limit: number },
    ) => Promise<{ ids: string[]; next: string | null }>
  >(),
);
const enqueueContactGoogleSync = vi.hoisted(() =>
  vi.fn<
    (payload: { organizationId: string; contactId: string }) => Promise<{ skipped: boolean }>
  >(),
);
const revalidatePath = vi.hoisted(() => vi.fn());
const ctx = vi.hoisted(() => ({ organizationId: "org-from-session", role: "admin" }));

vi.mock("@crm/automation", () => ({ enqueueContactGoogleSync }));
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
  listGoogleSyncContactIds,
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
  listGoogleSyncContactIds.mockReset();
  enqueueContactGoogleSync.mockReset();
  revalidatePath.mockReset();
  enqueueContactGoogleSync.mockResolvedValue({ skipped: false });
});

let run = 0;

describe("syncGoogleContactsAction", () => {
  it("rejects a repeat request inside the cooldown without enqueueing again", async () => {
    listGoogleSyncContactIds.mockResolvedValue({ ids: ["a"], next: null });
    await syncGoogleContactsAction();
    enqueueContactGoogleSync.mockClear();

    const result = await syncGoogleContactsAction();

    expect(result.ok).toBe(false);
    expect(enqueueContactGoogleSync).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61_000);
    await expect(syncGoogleContactsAction()).resolves.toMatchObject({ ok: true });
  });

  it("queues every page for the session's organization and passes the cursor forward", async () => {
    listGoogleSyncContactIds
      .mockResolvedValueOnce({ ids: ["a", "b"], next: "b" })
      .mockResolvedValueOnce({ ids: ["c"], next: null });

    await expect(syncGoogleContactsAction()).resolves.toEqual({ ok: true, queued: 3 });

    expect(listGoogleSyncContactIds.mock.calls.map((call) => call[2].after)).toEqual([
      undefined,
      "b",
    ]);
    expect(enqueueContactGoogleSync.mock.calls.map((call) => call[0])).toEqual([
      { organizationId: "org-from-session", contactId: "a" },
      { organizationId: "org-from-session", contactId: "b" },
      { organizationId: "org-from-session", contactId: "c" },
    ]);
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("is a no-op success when no contact is eligible", async () => {
    listGoogleSyncContactIds.mockResolvedValue({ ids: [], next: null });
    await expect(syncGoogleContactsAction()).resolves.toEqual({ ok: true, queued: 0 });
    expect(enqueueContactGoogleSync).not.toHaveBeenCalled();
  });

  it("stops at the first skipped enqueue and says how many were already queued", async () => {
    listGoogleSyncContactIds.mockResolvedValue({ ids: ["a", "b", "c"], next: null });
    enqueueContactGoogleSync
      .mockResolvedValueOnce({ skipped: false })
      .mockResolvedValueOnce({ skipped: true });

    const result = await syncGoogleContactsAction();

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain("1 contatos já foram enfileirados");
    expect(enqueueContactGoogleSync).toHaveBeenCalledTimes(2);
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("returns the domain error instead of throwing (e.g. Google not connected)", async () => {
    const { DomainError } = await import("@crm/core");
    listGoogleSyncContactIds.mockRejectedValue(
      new DomainError("GOOGLE_NOT_CONNECTED", "Nenhuma conta Google conectada."),
    );
    await expect(syncGoogleContactsAction()).resolves.toEqual({
      ok: false,
      error: "Nenhuma conta Google conectada.",
    });
  });
});
