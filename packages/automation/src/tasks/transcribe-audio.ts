import type { SttCredential } from "@crm/ai";
import { transcribeAudio } from "@crm/ai";
import type { ChannelProvider } from "@crm/channels";
import { recordUsageEvents, resolveOrgLlmCredentials } from "@crm/core/ai";
import { providerForConnection } from "@crm/core/integrations";
import { getMessage, mergeMessageMetadata } from "@crm/core/messaging";
import { findSettings } from "@crm/core/organizations";
import type { Database } from "@crm/db";
import { emitDomainEvent, getDb, withTenant } from "@crm/db";
import { createLogger } from "@crm/observability";
import { z } from "zod";

const logger = createLogger({ bindings: { component: "jobs" } });

export const transcribeAudioPayload = z.object({
  organizationId: z.uuid(),
  messageId: z.uuid(),
  channelConnectionId: z.uuid(),
});

export type TranscribeAudioPayload = z.infer<typeof transcribeAudioPayload>;

export type TranscribeAudioDeps = {
  /** STT call — injectable so tests don't hit a real provider. */
  transcribe?: typeof transcribeAudio;
  /** Channel provider — injectable; defaults to the connection's adapter. */
  provider?: ChannelProvider;
};

type Prepared = {
  mediaUrl: string;
  mimeType?: string;
  conversationId: string;
  credential: SttCredential & { id: string; model: string };
};

/**
 * Tenant-scoped gather: message + settings + credentials in one tx.
 * Returns null for every "nothing to do" path — deduped replays,
 * non-audio content, disabled toggle, missing BYOK, already transcribed.
 */
async function prepare(db: Database, payload: TranscribeAudioPayload): Promise<Prepared | null> {
  return withTenant(db, payload.organizationId, async (tx) => {
    const [message, settings, credentials] = await Promise.all([
      getMessage(tx, payload.messageId),
      findSettings(tx, payload.organizationId),
      resolveOrgLlmCredentials(tx, payload.organizationId),
    ]);
    // Missing settings row = defaults (ai_transcribe_audio defaults true).
    if (!message || !(settings?.aiTranscribeAudio ?? true)) return null;
    const metadata = message.metadata as Record<string, unknown>;
    if (typeof metadata.transcript === "string") return null;
    const content = message.content as {
      type?: string;
      mediaKind?: string;
      mimeType?: string;
      source?: { type: string; url?: string };
    };
    if (content.type !== "media" || content.mediaKind !== "audio") return null;
    if (content.source?.type !== "url" || !content.source.url) return null;
    // Anthropic has no audio surface — only OpenAI/OpenRouter qualify.
    const stt = credentials.find((c) => c.provider === "openai" || c.provider === "openrouter");
    if (!stt) return null;
    return {
      mediaUrl: content.source.url,
      mimeType: content.mimeType,
      conversationId: message.conversationId,
      credential: {
        id: stt.id,
        model: stt.model,
        provider: stt.provider as "openai" | "openrouter",
        apiKey: stt.apiKey,
      },
    };
  });
}

type TranscribeContext = {
  db: Database;
  payload: TranscribeAudioPayload;
  prepared: Prepared;
  deps: TranscribeAudioDeps | undefined;
};

const logUsageFailure = (error: unknown) =>
  logger.warn("stt usage record failed", { error: String(error) });

function usageRecorder({ db, payload, prepared }: TranscribeContext) {
  const startedAt = Date.now();
  const { credential } = prepared;
  return (status: "ok" | "error") =>
    withTenant(db, payload.organizationId, (tx) =>
      recordUsageEvents(tx, payload.organizationId, [
        {
          credentialId: credential.id,
          callKind: "stt",
          provider: credential.provider,
          model: credential.model,
          tokensIn: 0,
          tokensOut: 0,
          latencyMs: Date.now() - startedAt,
          status,
        },
      ]),
    );
}

/** Fetches the audio, transcribes it and stores the transcript; `skipped` when the provider can't fetch media. */
async function transcribeAndStore(ctx: TranscribeContext): Promise<{ ok: true; skipped?: true }> {
  const { db, payload, prepared, deps } = ctx;
  const provider =
    deps?.provider ??
    (await providerForConnection(db, payload.organizationId, payload.channelConnectionId));
  if (!provider.fetchMedia) return { ok: true, skipped: true };
  const media = await provider.fetchMedia(prepared.mediaUrl);
  const { credential } = prepared;
  const { text } = await (deps?.transcribe ?? transcribeAudio)(
    { audio: media.body, mimeType: media.contentType ?? prepared.mimeType },
    { provider: credential.provider, apiKey: credential.apiKey },
  );
  await withTenant(db, payload.organizationId, async (tx) => {
    await mergeMessageMetadata(tx, payload.messageId, {
      transcript: text,
      transcriptProvider: credential.provider,
    });
    await emitDomainEvent(tx, {
      type: "message.updated",
      organizationId: payload.organizationId,
      conversationId: prepared.conversationId,
      messageId: payload.messageId,
    });
  });
  return { ok: true };
}

/** Never throws: a failure is recorded as a usage event and logged. */
async function transcribeSafely(ctx: TranscribeContext): Promise<{ ok: boolean; skipped?: true }> {
  const record = usageRecorder(ctx);
  try {
    const result = await transcribeAndStore(ctx);
    if (!result.skipped) await record("ok").catch(logUsageFailure);
    return result;
  } catch (error) {
    await record("error").catch(logUsageFailure);
    logger.warn("audio transcription failed", {
      organizationId: ctx.payload.organizationId,
      messageId: ctx.payload.messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false };
  }
}

/**
 * Transcribes an inbound audio message: provider fetchMedia → BYOK STT →
 * `metadata.transcript` + a message.updated event so the open thread
 * refreshes. Best-effort — failures are recorded as usage events and
 * logged, never thrown (a bad transcript must not retry-storm the queue
 * nor block ingest).
 */
export async function transcribeAudioHandler(
  payload: unknown,
  deps?: TranscribeAudioDeps,
): Promise<{ ok: boolean; skipped?: boolean }> {
  const parsed = transcribeAudioPayload.parse(payload);
  const db = getDb();
  const prepared = await prepare(db, parsed);
  if (!prepared) return { ok: true, skipped: true };

  return transcribeSafely({ db, payload: parsed, prepared, deps });
}
