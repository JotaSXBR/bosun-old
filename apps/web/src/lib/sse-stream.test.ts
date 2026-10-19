import { subscribeDomainEvents } from "@crm/db";
import { captureException } from "@crm/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sseResponse } from "./sse-stream";

vi.mock("@crm/db", () => ({ subscribeDomainEvents: vi.fn() }));
vi.mock("@crm/observability", () => ({ captureException: vi.fn() }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value } = await reader.read();
  return new TextDecoder().decode(value);
}

describe("sseResponse", () => {
  beforeEach(() => {
    vi.mocked(subscribeDomainEvents).mockReset();
    vi.mocked(captureException).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("sets the event-stream headers and merges the caller's", () => {
    vi.mocked(subscribeDomainEvents).mockResolvedValue(() => Promise.resolve());
    const response = sseResponse({
      signal: new AbortController().signal,
      organizationId: "org",
      routeTag: "t",
      onEvent: () => undefined,
      headers: { "access-control-allow-origin": "*" },
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("opens with the retry hint, then forwards org events through send", async () => {
    let publish: (event: never) => void = () => undefined;
    vi.mocked(subscribeDomainEvents).mockImplementation((_org, handler) => {
      publish = handler;
      return Promise.resolve(() => Promise.resolve());
    });
    const response = sseResponse({
      signal: new AbortController().signal,
      organizationId: "org",
      routeTag: "t",
      onEvent: (_event, send) => send("data: hi\n\n"),
    });
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe("retry: 3000\n\n");
    expect(await readChunk(reader)).toBe(": connected\n\n");
    await flush();
    publish({} as never);
    expect(await readChunk(reader)).toBe("data: hi\n\n");
  });

  it("unsubscribes and closes the stream when the client aborts", async () => {
    const unsubscribe = vi.fn();
    vi.mocked(subscribeDomainEvents).mockResolvedValue(unsubscribe);
    const abort = new AbortController();
    const response = sseResponse({
      signal: abort.signal,
      organizationId: "org",
      routeTag: "t",
      onEvent: () => undefined,
    });
    const reader = response.body!.getReader();
    await readChunk(reader);
    abort.abort();
    await flush();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await reader.read(); // drains ": connected"
    expect((await reader.read()).done).toBe(true);
  });

  it("reports a failed subscription and closes instead of hanging", async () => {
    const error = new Error("listen failed");
    vi.mocked(subscribeDomainEvents).mockRejectedValue(error);
    const response = sseResponse({
      signal: new AbortController().signal,
      organizationId: "org",
      routeTag: "route-x",
      onEvent: () => undefined,
    });
    const reader = response.body!.getReader();
    await flush();
    expect(captureException).toHaveBeenCalledWith(error, { route: "route-x" });
    await reader.read();
    await reader.read();
    expect((await reader.read()).done).toBe(true);
  });

  it("sends a heartbeat every 25s", async () => {
    vi.useFakeTimers();
    vi.mocked(subscribeDomainEvents).mockResolvedValue(() => Promise.resolve());
    const response = sseResponse({
      signal: new AbortController().signal,
      organizationId: "org",
      routeTag: "t",
      onEvent: () => undefined,
    });
    const reader = response.body!.getReader();
    await readChunk(reader);
    await readChunk(reader);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await readChunk(reader)).toBe(": ping\n\n");
  });
});
