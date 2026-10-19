import { enqueueChannelEventProcessed } from "@crm/automation";
import { sendWidgetMessage } from "@crm/core/messaging";
import { getDb } from "@crm/db";
import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  corsJson,
  corsOptions,
  parseJsonBody,
  rateLimit,
  widgetErrorResponse,
} from "../../../../lib/widget-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const widgetMessageInput = z.object({
  sessionToken: z.string().min(1).max(128),
  text: z.string().min(1).max(4000),
  clientMessageId: z.string().min(1).max(64).optional(),
});

export function OPTIONS(): Response {
  return corsOptions();
}

/**
 * Public widget inbound — session token authorizes writing as the visitor;
 * the message runs the standard ingest pipeline (off-hours auto-reply and
 * the process-channel-event job come for free).
 */
export async function POST(request: NextRequest): Promise<Response> {
  const input = await parseJsonBody(request, widgetMessageInput);
  if ("response" in input) return input.response;
  const { sessionToken, text, clientMessageId } = input.data;
  if (!rateLimit(`widget:message:${sessionToken}`, 30, 60_000)) {
    return corsJson({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  try {
    await sendWidgetMessage(getDb(), sessionToken, {
      input: { text, clientMessageId },
      deps: { enqueue: (executor, payload) => enqueueChannelEventProcessed(payload, executor) },
    });
    return corsJson({ ok: true });
  } catch (error) {
    return widgetErrorResponse(error, "widget.message", "unknown_session");
  }
}
