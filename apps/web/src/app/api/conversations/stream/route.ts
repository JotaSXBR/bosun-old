import { subscribeDomainEvents } from "@crm/db";
import { captureException } from "@crm/observability";
import type { NextRequest } from "next/server";

import { getTenantContext } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const ROUTE_TAG = "api.conversations.stream";

/**
 * Org-scoped SSE stream of domain events (message.received today). The tenant
 * comes from the Better Auth session — never from query params. Each client
 * holds one dedicated LISTEN connection for the life of the stream.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const ctx = await getTenantContext();
  if (!ctx) {
    return Response.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }

  const encoder = new TextEncoder();
  let cleanup = (): void => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
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

      send("retry: 3000\n\n");
      send(": connected\n\n");
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);

      const subscription = subscribeDomainEvents(ctx.organizationId, (event) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      }).catch((error: unknown) => {
        captureException(error, { route: ROUTE_TAG });
        clearInterval(heartbeat);
        close();
        return null;
      });

      cleanup = () => {
        clearInterval(heartbeat);
        void subscription
          .then((unsubscribe) => unsubscribe?.())
          .catch((error: unknown) => captureException(error, { route: ROUTE_TAG }))
          .finally(close);
      };
      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
