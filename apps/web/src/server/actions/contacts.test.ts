import { beforeEach, describe, expect, it, vi } from "vitest";

const isGoogleAutoSyncActive = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const enqueueContactGoogleSync = vi.hoisted(() => vi.fn<() => Promise<{ skipped: boolean }>>());
const createContact = vi.hoisted(() => vi.fn());
const updateContactProfile = vi.hoisted(() => vi.fn());
const captureException = vi.hoisted(() => vi.fn());
const ctx = vi.hoisted(() => ({ organizationId: "org-from-session", role: "admin" }));

vi.mock("@crm/automation", () => ({ enqueueContactGoogleSync }));
vi.mock("@crm/core", () => ({ DomainError: class extends Error {} }));
vi.mock("@crm/core/contacts", () => ({ createContact, updateContactProfile }));
vi.mock("@crm/core/external-connections", () => ({ isGoogleAutoSyncActive }));
vi.mock("@crm/core/messaging", () => ({ startOutboundConversation: vi.fn() }));
vi.mock("@crm/db", () => ({ getDb: () => ({}) }));
vi.mock("@crm/observability", () => ({ captureException }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/tenant", () => ({ requireTenantContext: () => Promise.resolve(ctx) }));

import { createContactAction, updateContactProfileAction } from "./contacts";

beforeEach(() => {
  vi.resetAllMocks();
  createContact.mockResolvedValue({ id: "c1" });
  updateContactProfile.mockResolvedValue({ id: "c1" });
  enqueueContactGoogleSync.mockResolvedValue({ skipped: false });
});

describe("google auto-sync trigger", () => {
  it("enqueues on create and update when auto-sync is active", async () => {
    isGoogleAutoSyncActive.mockResolvedValue(true);
    expect(await createContactAction({} as never)).toEqual({ ok: true, id: "c1" });
    expect(await updateContactProfileAction({ contactId: "c1" })).toEqual({ ok: true });
    expect(enqueueContactGoogleSync).toHaveBeenCalledTimes(2);
    expect(enqueueContactGoogleSync).toHaveBeenCalledWith({
      organizationId: "org-from-session",
      contactId: "c1",
    });
  });

  it("does not enqueue without consent", async () => {
    isGoogleAutoSyncActive.mockResolvedValue(false);
    await updateContactProfileAction({ contactId: "c1" });
    expect(enqueueContactGoogleSync).not.toHaveBeenCalled();
  });

  it("does not fail the edit when the queue throws", async () => {
    isGoogleAutoSyncActive.mockResolvedValue(true);
    enqueueContactGoogleSync.mockRejectedValue(new Error("boom"));
    expect(await updateContactProfileAction({ contactId: "c1" })).toEqual({ ok: true });
    expect(captureException).toHaveBeenCalledOnce();
  });
});
