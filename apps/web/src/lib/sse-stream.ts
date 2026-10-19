import type { DomainEvent } from "@crm/db";
import { subscribeDomainEvents } from "@crm/db";
import { captureException } from "@crm/observability";

const HEARTBEAT_MS = 25_000;

type SseOptions = {
  signal: AbortSignal;
  organizationId: string;
  routeTag: string;
  /** Called per org event; `send` writes a raw SSE chunk. */
  onEvent: (event: DomainEvent, send: (chunk: string) => void) => void;
  headers?: Record<string, string>;
};

/** Enqueue/close wrappers that go quiet once the client is gone. */
function sseWriter(controller: ReadableStreamDefaultController<Uint8Array>) {
  const encoder = new TextEncoder();
  let closed = false;
  const send = (chunk: string): void => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      closed = true;
    }
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {
      // Already closed or cancelled.
    }
  };
  return { send, close };
}

/**
 * SSE response over the org's domain events: retry hint, heartbeat, one
 * dedicated LISTEN connection released when the client goes away.
 */
export function sseResponse(options: SseOptions): Response {
  const { signal, organizationId, routeTag, onEvent, headers } = options;
  let cleanup = (): void => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const { send, close } = sseWriter(controller);

      send("retry: 3000\n\n");
      send(": connected\n\n");
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);

      const subscription = subscribeDomainEvents(organizationId, (event) =>
        onEvent(event, send),
      ).catch((error: unknown) => {
        captureException(error, { route: routeTag });
        clearInterval(heartbeat);
        close();
        return null;
      });

      cleanup = () => {
        clearInterval(heartbeat);
        void subscription
          .then((unsubscribe) => unsubscribe?.())
          .catch((error: unknown) => captureException(error, { route: routeTag }))
          .finally(close);
      };
      signal.addEventListener("abort", cleanup, { once: true });
      if (signal.aborted) cleanup(); // the listener never fires for an already-aborted signal
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      ...headers,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
