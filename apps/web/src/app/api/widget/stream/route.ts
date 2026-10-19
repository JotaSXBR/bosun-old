import { getWidgetStreamTarget } from "@crm/core/messaging";
import { getDb } from "@crm/db";
import { captureException } from "@crm/observability";
import type { NextRequest } from "next/server";

import { sseResponse } from "../../../../lib/sse-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE_TAG = "api.widget.stream";
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** The visitor session behind the token, or the ready error response. */
async function resolveTarget(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return Response.json({ ok: false, error: "missing_token" }, { status: 400 });
  }
  const target = await getWidgetStreamTarget(getDb(), token).catch((error: unknown) => {
    captureException(error, { route: ROUTE_TAG });
    return undefined;
  });
  if (!target) {
    return Response.json({ ok: false, error: "unknown_session" }, { status: 404 });
  }
  return target;
}

/**
 * Public widget SSE — the session token resolves the visitor's current
 * conversation; org-scoped domain events are filtered down to it and
 * forwarded as a bare "updated" ping (the widget refetches history, which
 * filters out internal notes — event payloads never reach the visitor).
 */
export async function GET(request: NextRequest): Promise<Response> {
  const target = await resolveTarget(request);
  if (target instanceof Response) return target;
  let conversationId = target.conversationId;
  return sseResponse({
    signal: request.signal,
    organizationId: target.organizationId,
    routeTag: ROUTE_TAG,
    headers: CORS_HEADERS,
    onEvent: (event, send) => {
      // First ticket may be created after the stream opened — adopt
      // only conversations of THIS visitor's contact (org-wide events
      // would otherwise leak other visitors' updates).
      if (
        !conversationId &&
        event.type === "conversation.created" &&
        event.contactId === target.contactId
      ) {
        conversationId = event.conversationId as string;
      }
      if (event.conversationId !== conversationId) return;
      send(`data: ${JSON.stringify({ type: "updated" })}\n\n`);
    },
  });
}
