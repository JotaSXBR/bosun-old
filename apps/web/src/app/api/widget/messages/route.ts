import { getWidgetConversation } from "@crm/core/messaging";
import { getDb } from "@crm/db";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { corsJson, corsOptions, rateLimit, widgetErrorResponse } from "../../../../lib/widget-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(): Response {
  return corsOptions();
}

/** Token, rate limit and cursor checks; the failure arm carries the ready error response. */
function readQuery(request: Request): { token: string; after: string | undefined } | Response {
  const params = new URL(request.url).searchParams;
  const token = params.get("token");
  if (!token) {
    return corsJson({ ok: false, error: "missing_token" }, { status: 400 });
  }
  if (!rateLimit(`widget:messages:${token}`, 60, 60_000)) {
    return corsJson({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const after = params.get("after") ?? undefined;
  if (after && !z.uuid().safeParse(after).success) {
    return corsJson({ ok: false, error: "invalid_after" }, { status: 400 });
  }
  return { token, after };
}

/**
 * Widget history — latest ticket + visitor-visible messages after the
 * `after` message-id cursor. The session token is the only auth.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const query = readQuery(request);
  if (query instanceof Response) return query;
  try {
    const result = await getWidgetConversation(getDb(), query.token, {
      after: query.after,
      limit: 50,
    });
    return corsJson({ ok: true, ...result });
  } catch (error) {
    return widgetErrorResponse(error, "widget.messages", "unknown_session");
  }
}
