import type { NextRequest } from "next/server";

import { getTenantContext } from "@/server/tenant";

import { sseResponse } from "../../../../lib/sse-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  return sseResponse({
    signal: request.signal,
    organizationId: ctx.organizationId,
    routeTag: ROUTE_TAG,
    onEvent: (event, send) => send(`data: ${JSON.stringify(event)}\n\n`),
  });
}
