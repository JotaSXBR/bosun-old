import { AuthorizationError, DomainError, NotFoundError } from "@crm/core";
import { captureException } from "@crm/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { routeErrorResponse } from "./route-error";

vi.mock("@crm/observability", () => ({ captureException: vi.fn() }));

async function respond(error: unknown) {
  const response = routeErrorResponse(error, "test-route");
  return { status: response.status, body: (await response.json()) as unknown };
}

describe("routeErrorResponse", () => {
  beforeEach(() => vi.mocked(captureException).mockClear());

  it("maps NotFoundError to 404 without leaking the message", async () => {
    expect(await respond(new NotFoundError("Contact", "1"))).toEqual({
      status: 404,
      body: { ok: false },
    });
  });

  it("maps AuthorizationError to 403", async () => {
    expect(await respond(new AuthorizationError())).toEqual({ status: 403, body: { ok: false } });
  });

  it("maps other domain errors to 400 with their code", async () => {
    expect(await respond(new DomainError("BAD_INPUT", "nope"))).toEqual({
      status: 400,
      body: { ok: false, error: "BAD_INPUT" },
    });
  });

  it("reports unknown errors and answers a bare 500", async () => {
    const boom = new Error("boom");
    expect(await respond(boom)).toEqual({ status: 500, body: { ok: false } });
    expect(captureException).toHaveBeenCalledWith(boom, { route: "test-route" });
  });

  it("does not report expected domain errors", async () => {
    await respond(new NotFoundError("Contact"));
    expect(captureException).not.toHaveBeenCalled();
  });
});
