import { createWidgetSession, widgetPreFormInput } from "@crm/core/messaging";
import { getDb } from "@crm/db";
import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  clientIp,
  corsJson,
  corsOptions,
  parseJsonBody,
  rateLimit,
  widgetErrorResponse,
} from "../../../../lib/widget-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sessionCreateInput = widgetPreFormInput.extend({
  connectionToken: z.string().min(1).max(128),
});

export function OPTIONS(): Response {
  return corsOptions();
}

/**
 * Public widget session bootstrap — the embed token identifies the
 * connection (it is public by design, like a Site-Key); the pre-form
 * identifies the visitor. Rate-limited per client IP.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!rateLimit(`widget:session:${clientIp(request)}`, 10, 60_000)) {
    return corsJson({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const input = await parseJsonBody(request, sessionCreateInput);
  if ("response" in input) return input.response;
  try {
    const session = await createWidgetSession(getDb(), input.data.connectionToken, input.data);
    return corsJson({ ok: true, ...session });
  } catch (error) {
    return widgetErrorResponse(error, "widget.session", "unknown_connection");
  }
}
