"use client";

// WhatsApp-style audio bubble: play/pause, a seekable waveform,
// elapsed/total time and a playback-speed cycler (1× → 1.5× → 2×). The
// native <audio> element has no speed affordance, so the chrome is
// custom.
import { Icon } from "@crm/design-system/components/icon";
import { cn } from "@crm/design-system/lib/utils";
import { useTranslations } from "next-intl";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";

import { AUDIO_WAVE_BARS, fallbackPeaks, loadAudioPeaks } from "@/lib/audio-peaks";

const SPEEDS = [1, 1.5, 2] as const;
const FALLBACK = fallbackPeaks(AUDIO_WAVE_BARS);

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioPlayer({
  src,
  durationHint,
  peaks: peaksProp,
}: {
  src: string;
  durationHint?: number;
  peaks?: number[];
}) {
  const t = useTranslations("message");
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState<number>(1);
  const [loadedPeaks, setLoadedPeaks] = useState<number[] | null>(null);

  // MediaRecorder webm blobs carry no duration metadata (el.duration is
  // Infinity). Discovering it by seeking works — but the seek must run on
  // a detached probe element: doing it on the visible <audio> can wedge
  // it in a seeking+muted state where play() never resolves.
  useEffect(() => {
    if (durationHint != null && Number.isFinite(durationHint) && durationHint > 0) return;
    const probe = document.createElement("audio");
    probe.preload = "metadata";
    probe.muted = true;
    let settled = false;
    const settle = () => {
      if (settled || !Number.isFinite(probe.duration)) return;
      settled = true;
      setDuration(probe.duration);
    };
    probe.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(probe.duration)) settle();
      else probe.currentTime = 1e7;
    });
    probe.addEventListener("timeupdate", settle);
    probe.src = src;
    return () => {
      probe.removeAttribute("src");
      probe.load();
    };
  }, [src, durationHint]);

  // Waveform peaks: the prop wins (the recorder decodes its own blob);
  // otherwise fetch+decode lazily. Failure falls back to flat bars so
  // the UI never breaks.
  useEffect(() => {
    if (peaksProp) return;
    let live = true;
    void loadAudioPeaks(src, AUDIO_WAVE_BARS).then((p) => {
      if (live) setLoadedPeaks(p ?? FALLBACK);
    });
    return () => {
      live = false;
    };
  }, [src, peaksProp]);

  // Refs only inside handlers/effects — render reads state alone.
  // Blob sources can report Infinity on the element itself, so the
  // probe-discovered duration (or the recorder's hint) is the fallback.
  const elementDuration = () => {
    const el = audioRef.current;
    return el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
  };
  const hint =
    durationHint != null && Number.isFinite(durationHint) && durationHint > 0 ? durationHint : 0;
  const displayTotal = Number.isFinite(duration) && duration > 0 ? duration : hint;
  const played = displayTotal > 0 ? Math.min(1, elapsed / displayTotal) : 0;

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length]!;
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };

  const seekTo = (fraction: number) => {
    const el = audioRef.current;
    const total = elementDuration() || displayTotal;
    if (!el || total <= 0) return;
    el.currentTime = Math.min(1, Math.max(0, fraction)) * total;
    setElapsed(el.currentTime);
  };

  const seekFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width > 0) seekTo((e.clientX - rect.left) / rect.width);
  };

  const onWaveKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const el = audioRef.current;
    const total = elementDuration() || displayTotal;
    if (!el || total <= 0) return;
    seekTo((el.currentTime + (e.key === "ArrowRight" ? 5 : -5)) / total);
  };

  const bars = peaksProp ?? loadedPeaks ?? FALLBACK;

  return (
    <div className="flex w-64 max-w-full items-center gap-2" data-testid="audio-player">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(d);
        }}
        onDurationChange={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(d);
        }}
        onEnded={() => setElapsed(0)}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? t("audioPause") : t("audioPlay")}
        className="bg-ink-on-signal/20 flex size-8 shrink-0 items-center justify-center rounded-full"
      >
        <Icon name={playing ? "pause" : "play"} className="size-4" />
      </button>
      <div
        role="slider"
        tabIndex={0}
        aria-label={t("audioSeek")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(played * 100)}
        aria-valuetext={`${formatTime(elapsed)} / ${formatTime(displayTotal)}`}
        className="flex h-6 min-w-0 flex-1 cursor-pointer touch-none items-center gap-px"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromPointer(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) seekFromPointer(e);
        }}
        onKeyDown={onWaveKey}
        data-testid="audio-waveform"
      >
        {bars.map((p, i) => (
          <span
            key={i}
            aria-hidden
            className={cn(
              "h-(--bar-h) min-w-0.5 flex-1 rounded-full",
              i / bars.length < played ? "bg-current" : "bg-current/35",
            )}
            style={{ "--bar-h": `${Math.round(p * 100)}%` } as CSSProperties}
          />
        ))}
      </div>
      <span className="min-w-9 shrink-0 text-xs tabular-nums">
        {formatTime(playing || elapsed > 0 ? elapsed : displayTotal)}
      </span>
      <button
        type="button"
        onClick={cycleSpeed}
        aria-label={t("audioSpeed")}
        className="bg-ink-on-signal/20 shrink-0 rounded-xs px-1.5 py-0.5 text-xs font-medium tabular-nums"
      >
        {speed}×
      </button>
    </div>
  );
}
