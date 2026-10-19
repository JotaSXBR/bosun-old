import type { TenantContext } from "@crm/core";
import { NotFoundError } from "@crm/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { findConversation } from "./find-conversation";

const getConversation = vi.hoisted(() => vi.fn());
vi.mock("@/server/services", () => ({ getConversation }));

const ctx: TenantContext = {
  organizationId: "org-1",
  userId: "user-1",
  role: "agent",
  isPlatformAdmin: false,
};

describe("findConversation", () => {
  beforeEach(() => {
    getConversation.mockReset();
  });

  it("returns the conversation the service found", async () => {
    const row = { id: "c-1" };
    getConversation.mockResolvedValue(row);
    await expect(findConversation(ctx, "c-1")).resolves.toBe(row);
    expect(getConversation).toHaveBeenCalledWith(ctx, "c-1");
  });

  it("returns null for NotFoundError (missing, or another organization's)", async () => {
    getConversation.mockImplementation(() =>
      Promise.reject(new NotFoundError("Conversation", "c-2")),
    );
    await expect(findConversation(ctx, "c-2")).resolves.toBeNull();
  });

  it("rethrows anything else — a database outage must not look like a 404", async () => {
    const outage = new Error("connection refused");
    getConversation.mockImplementation(() => Promise.reject(outage));
    await expect(findConversation(ctx, "c-3")).rejects.toBe(outage);
  });
});
