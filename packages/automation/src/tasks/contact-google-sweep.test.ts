import { beforeEach, describe, expect, it, vi } from "vitest";

const isGoogleAutoSyncActive = vi.hoisted(() => vi.fn());
const listGoogleAutoSyncOrganizationIds = vi.hoisted(() => vi.fn());
const listPendingGoogleSyncContactIds = vi.hoisted(() => vi.fn());
const markGoogleSweepAt = vi.hoisted(() => vi.fn());
const enqueueContactGoogleSync = vi.hoisted(() =>
  vi.fn<(p: { organizationId: string; contactId: string }) => Promise<{ skipped: boolean }>>(),
);
vi.mock("@crm/core/external-connections", () => ({
  isGoogleAutoSyncActive,
  listGoogleAutoSyncOrganizationIds,
  listPendingGoogleSyncContactIds,
  markGoogleSweepAt,
}));
vi.mock("@crm/db", () => ({ getDb: () => ({}) }));
vi.mock("@crm/observability", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock("../enqueue", () => ({ enqueueContactGoogleSync }));

import { contactGoogleSweepHandler } from "./contact-google-sweep";

const A = "018f8b9a-7c3d-7f2e-9a4b-1c2d3e4f5a6b";
const B = "118f8b9a-7c3d-7f2e-9a4b-1c2d3e4f5a6b";
const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);

beforeEach(() => {
  vi.resetAllMocks();
  isGoogleAutoSyncActive.mockResolvedValue(true);
  enqueueContactGoogleSync.mockResolvedValue({ skipped: false });
  listPendingGoogleSyncContactIds.mockResolvedValue({ ids: ["a", "b"], next: null });
});

describe("contactGoogleSweepHandler", () => {
  it("queues the pending contacts of the payload's org and stamps the sweep", async () => {
    await expect(contactGoogleSweepHandler({ organizationId: A })).resolves.toEqual({
      orgs: 1,
      queued: 2,
    });
    expect(enqueueContactGoogleSync.mock.calls.map((c) => c[0])).toEqual([
      { organizationId: A, contactId: "a" },
      { organizationId: A, contactId: "b" },
    ]);
    expect(markGoogleSweepAt).toHaveBeenCalledWith({}, A);
    expect(listGoogleAutoSyncOrganizationIds).not.toHaveBeenCalled();
  });

  it("skips an org without active auto-sync (no consent or needs_reauth)", async () => {
    listGoogleAutoSyncOrganizationIds.mockResolvedValue([A, B]);
    isGoogleAutoSyncActive.mockImplementation((_db: unknown, org: string) =>
      Promise.resolve(org === B),
    );

    await expect(contactGoogleSweepHandler(null)).resolves.toEqual({ orgs: 1, queued: 2 });
    expect(enqueueContactGoogleSync.mock.calls.every((c) => c[0].organizationId === B)).toBe(true);
  });

  it("caps the contacts queued per org in one run", async () => {
    listPendingGoogleSyncContactIds.mockImplementation(() =>
      Promise.resolve({ ids: ids(200), next: "x" }),
    );

    const result = await contactGoogleSweepHandler({ organizationId: A });

    expect(result.queued).toBe(500);
    expect(enqueueContactGoogleSync).toHaveBeenCalledTimes(500);
  });

  it("keeps sweeping the other orgs when one fails", async () => {
    listGoogleAutoSyncOrganizationIds.mockResolvedValue([A, B]);
    listPendingGoogleSyncContactIds
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ids: ["a"], next: null });

    await expect(contactGoogleSweepHandler({})).resolves.toEqual({ orgs: 2, queued: 1 });
  });

  it("stops without stamping when the jobs layer is down", async () => {
    enqueueContactGoogleSync.mockResolvedValue({ skipped: true });
    await expect(contactGoogleSweepHandler({ organizationId: A })).resolves.toEqual({
      orgs: 1,
      queued: 0,
    });
    expect(markGoogleSweepAt).not.toHaveBeenCalled();
  });
});
