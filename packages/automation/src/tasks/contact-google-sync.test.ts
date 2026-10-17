import { beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.hoisted(() => vi.fn());
const syncContactToGoogle = vi.hoisted(() => vi.fn());
vi.mock("@crm/observability", () => ({ captureException }));
vi.mock("@crm/core/external-connections", () => ({ syncContactToGoogle }));
vi.mock("@crm/db", () => ({ getDb: () => ({}) }));

import { contactGoogleSyncHandler } from "./contact-google-sync";

const payload = {
  organizationId: "018f8b9a-7c3d-7f2e-9a4b-1c2d3e4f5a6b",
  contactId: "218f8b9a-7c3d-7f2e-9a4b-1c2d3e4f5a6b",
};

beforeEach(() => {
  captureException.mockReset();
  syncContactToGoogle.mockReset();
});

describe("contactGoogleSyncHandler", () => {
  it("completes (never throws) on a malformed payload so the org's queue key is not held", async () => {
    await expect(contactGoogleSyncHandler({ organizationId: "nope" })).resolves.toEqual({
      ok: false,
    });
    expect(captureException).toHaveBeenCalledOnce();
    expect(syncContactToGoogle).not.toHaveBeenCalled();
  });

  it("syncs the contact of the payload's organization", async () => {
    syncContactToGoogle.mockResolvedValue("created");
    await expect(contactGoogleSyncHandler(payload)).resolves.toEqual({ ok: true });
    expect(syncContactToGoogle).toHaveBeenCalledWith({}, payload);
  });

  it("reports an unexpected error and still completes the job", async () => {
    syncContactToGoogle.mockRejectedValue(
      new Error('Failed query: update "contacts" ... params: {"phone":"+5511999990001"}'),
    );
    await expect(contactGoogleSyncHandler(payload)).resolves.toEqual({ ok: false });
    // The reported error carries no SQL/params (contact PII), only the class and ids.
    expect(captureException).toHaveBeenCalledWith(new Error("contact-google-sync failed: Error"), {
      job: "contact-google-sync",
      contactId: payload.contactId,
    });
  });
});
