import {
  enqueueChannelEventProcessed,
  enqueueContactAvatar,
  enqueueContactGoogleSync,
  enqueueTranscribeAudio,
} from "@crm/automation";
import { NotFoundError, WebhookVerificationError } from "@crm/core";
import { ingestChannelWebhook } from "@crm/core/messaging";
import { getDb } from "@crm/db";
import { captureException, createLogger } from "@crm/observability";
import type { NextRequest } from "next/server";

import { readWebhookRequest } from "../../../../../lib/webhook-request";

const logger = createLogger({ bindings: { component: "channel-webhook" } });

function failure(error: unknown): Response {
  if (error instanceof NotFoundError) {
    return Response.json({ ok: false }, { status: 404 });
  }
  if (error instanceof WebhookVerificationError) {
    return Response.json({ ok: false }, { status: 401 });
  }
  captureException(error, { route: "webhooks.channels" });
  logger.error("channel webhook failed", { error: (error as Error).message });
  return Response.json({ ok: false }, { status: 500 });
}

/**
 * Channel webhook ingestion. The path token is the only routing credential:
 * it resolves the connection under service scope, the provider signature is
 * verified on the raw body, and only then are events normalized and persisted
 * inside the connection's tenant. Always 200 after verification — unknown or
 * duplicate events are acknowledged, not retried.
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  const webhook = await readWebhookRequest(request);

  try {
    const result = await ingestChannelWebhook(getDb(), token, {
      request: webhook,
      deps: {
        // Job rows commit atomically with each event's ingest transaction.
        enqueue: (executor, payload) => enqueueChannelEventProcessed(payload, executor),
        enqueueAvatar: (executor, payload) => enqueueContactAvatar(payload, executor),
        enqueueGoogleSync: (executor, payload) => enqueueContactGoogleSync(payload, executor),
        enqueueTranscribe: (executor, payload) => enqueueTranscribeAudio(payload, executor),
      },
    });
    if (result.processed.length === 0) {
      logger.warn("channel webhook carried no recognized events", {
        channelConnectionId: result.channelConnectionId,
      });
    }
    return Response.json({ ok: true, processed: result.processed.length });
  } catch (error) {
    return failure(error);
  }
}
