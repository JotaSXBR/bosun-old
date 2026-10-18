"use client";

// WhatsApp-style voice notes: record → listen to a preview → re-record,
// discard or send. Sent as voiceNote → WAHA sendVoice (PTT bubble).
import { Button } from "@crm/design-system/components/button";
import { toast } from "@crm/design-system/components/toast";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { AudioPlayer } from "@/components/audio-player";
import { AUDIO_WAVE_BARS, decodeAudioPeaks } from "@/lib/audio-peaks";
import { sendMediaMessageAction } from "@/server/actions/chat";

type Phase = "idle" | "recording" | "preview";
type Presence = { signal: (p: "typing" | "recording") => void; pause: () => void };

type RecorderState = {
  phase: Phase;
  elapsed: number;
  previewUrl: string | null;
  peaks: number[] | null;
  sending: boolean;
};

type MediaRefs = {
  blob: Blob | null;
  mime: string;
  recorder: MediaRecorder | null;
  stream: MediaStream | null;
  chunks: Blob[];
  previewUrl: string | null;
};

const PREFERRED_MIME = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_MIME.find((t) => MediaRecorder.isTypeSupported(t));
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function extOf(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4")) return "mp4";
  return "webm";
}

function RecordingBar({
  elapsed,
  onStop,
  onDiscard,
}: {
  elapsed: number;
  onStop: () => void;
  onDiscard: () => void;
}) {
  const t = useTranslations("composer");
  return (
    <div
      className="border-danger/40 bg-danger/10 flex items-center gap-3 rounded-md border px-3 py-2"
      data-testid="voice-recorder"
    >
      <span className="bg-danger size-2 animate-pulse rounded-full" />
      <span className="text-sm font-medium tabular-nums">{formatElapsed(elapsed)}</span>
      <span className="text-ink-muted flex-1 text-xs">{t("recording")}</span>
      <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>
        {t("discard")}
      </Button>
      <Button variant="primary" type="button" size="sm" onClick={onStop}>
        {t("stop")}
      </Button>
    </div>
  );
}

function PreviewBar({
  previewUrl,
  elapsed,
  peaks,
  sending,
  onRerecord,
  onDiscard,
  onSend,
}: {
  previewUrl: string;
  elapsed: number;
  peaks: number[] | null;
  sending: boolean;
  onRerecord: () => void;
  onDiscard: () => void;
  onSend: () => void;
}) {
  const t = useTranslations("composer");
  return (
    <div
      className="flex items-center gap-2 rounded-md border px-3 py-2"
      data-testid="voice-preview"
    >
      <AudioPlayer src={previewUrl} durationHint={elapsed} peaks={peaks ?? undefined} />
      <Button type="button" size="sm" variant="ghost" onClick={onRerecord}>
        {t("rerecord")}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>
        {t("discard")}
      </Button>
      <Button variant="primary" type="button" size="sm" onClick={onSend} disabled={sending}>
        {sending ? t("sending") : t("send")}
      </Button>
    </div>
  );
}

export function VoiceRecorder({
  conversationId,
  disabled,
  presence,
}: {
  conversationId: string;
  disabled: boolean;
  presence: Presence;
}) {
  const t = useTranslations("composer");
  const router = useRouter();
  const media = useRef<MediaRefs>({
    blob: null,
    mime: "audio/webm",
    recorder: null,
    stream: null,
    chunks: [],
    previewUrl: null,
  });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [state, setState] = useState<RecorderState>({
    phase: "idle",
    elapsed: 0,
    previewUrl: null,
    peaks: null,
    sending: false,
  });

  // Refs-only cleanup — stable identity so it can be the unmount effect.
  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    media.current.stream?.getTracks().forEach((t) => t.stop());
    media.current.stream = null;
    media.current.recorder = null;
    if (media.current.previewUrl) URL.revokeObjectURL(media.current.previewUrl);
    media.current.previewUrl = null;
    media.current.blob = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const reset = () => {
    if (media.current.recorder?.state === "recording") media.current.recorder.stop();
    cleanup();
    presence.pause();
    setState({ phase: "idle", elapsed: 0, previewUrl: null, peaks: null, sending: false });
  };

  const start = async () => {
    try {
      cleanup();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      media.current.stream = stream;
      const mime = pickMime();
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      media.current.mime = recorder.mimeType || "audio/webm";
      media.current.chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) media.current.chunks.push(e.data);
      };
      recorder.onstop = () => {
        media.current.blob = new Blob(media.current.chunks, { type: media.current.mime });
        const url = URL.createObjectURL(media.current.blob);
        media.current.previewUrl = url;
        media.current.stream?.getTracks().forEach((t) => t.stop());
        media.current.stream = null;
        setState((s) => ({ ...s, phase: "preview", previewUrl: url }));
        // Waveform for the preview — decoded from the blob we already
        // hold (a fetch() of the blob: url would hit connect-src). Decode
        // failure leaves peaks null and the player falls back.
        void media.current.blob
          .arrayBuffer()
          .then((bytes) => decodeAudioPeaks(bytes, AUDIO_WAVE_BARS))
          .then((peaks) => setState((s) => (s.phase === "preview" ? { ...s, peaks } : s)))
          .catch(() => undefined);
      };
      media.current.recorder = recorder;
      recorder.start(250);
      setState((s) => ({ ...s, phase: "recording", elapsed: 0 }));
      timerRef.current = setInterval(() => {
        setState((s) => ({ ...s, elapsed: s.elapsed + 1 }));
        presence.signal("recording");
      }, 1000);
    } catch {
      toast.error(t("micError"));
    }
  };

  const stop = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    presence.pause();
    media.current.recorder?.stop();
  };

  const send = async () => {
    const blob = media.current.blob;
    if (!blob) return;
    setState((s) => ({ ...s, sending: true }));
    const form = new FormData();
    form.set("conversationId", conversationId);
    form.set("voiceNote", "true");
    form.set(
      "file",
      new File([blob], `audio-${Date.now()}.${extOf(media.current.mime)}`, {
        type: media.current.mime,
      }),
    );
    // A transport rejection (body over the Next limit) never reaches the
    // action — catch it or `sending` would stay true forever.
    const result = await sendMediaMessageAction(form).catch(() => null);
    setState((s) => ({ ...s, sending: false }));
    if (!result) {
      toast.error(t("uploadFailed"));
      return;
    }
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    reset();
    router.refresh();
  };

  if (state.phase === "recording") {
    return <RecordingBar elapsed={state.elapsed} onStop={stop} onDiscard={reset} />;
  }
  if (state.phase === "preview" && state.previewUrl) {
    return (
      <PreviewBar
        previewUrl={state.previewUrl}
        elapsed={state.elapsed}
        peaks={state.peaks}
        sending={state.sending}
        onRerecord={() => void start()}
        onDiscard={reset}
        onSend={() => void send()}
      />
    );
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={disabled}
      onClick={() => void start()}
      title={t("recordTitle")}
      data-testid="voice-record-button"
    >
      🎤
    </Button>
  );
}
