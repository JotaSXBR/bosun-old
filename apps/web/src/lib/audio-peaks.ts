// Waveform peaks for the audio player — extracted from decoded audio
// (OfflineAudioContext) with a deterministic fallback for codecs the
// browser can't decode (e.g. Safari + webm/opus).

export const AUDIO_WAVE_BARS = 40;

function rawPeaks(data: Float32Array, bars: number): number[] {
  const bucket = Math.max(1, Math.ceil(data.length / bars));
  const peaks = new Array<number>(bars).fill(0);
  for (let i = 0; i < bars; i++) {
    const start = i * bucket;
    let peak = 0;
    for (let j = start; j < Math.min(start + bucket, data.length); j++) {
      const v = Math.abs(data[j] ?? 0);
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
  }
  return peaks;
}

/**
 * Buckets channel samples into `bars` peaks normalized to 0..1. A floor
 * keeps near-silent bars visible — WhatsApp-style waveforms never go
 * fully flat. Silence/empty input returns the deterministic fallback.
 */
export function peaksFromChannel(data: Float32Array, bars: number): number[] {
  if (bars <= 0) return [];
  if (data.length === 0) return fallbackPeaks(bars);
  const peaks = rawPeaks(data, bars);
  const max = Math.max(...peaks);
  if (max <= 0) return fallbackPeaks(bars);
  return peaks.map((p) => Math.max(0.15, p / max));
}

/** Deterministic mid-height bars when audio can't be decoded at all. */
export function fallbackPeaks(bars: number): number[] {
  return Array.from(
    { length: Math.max(0, bars) },
    (_, i) => 0.3 + 0.3 * Math.abs(Math.sin(i * 1.3)),
  );
}

/** Decodes encoded audio bytes into normalized peaks. Throws if unsupported. */
export async function decodeAudioPeaks(bytes: ArrayBuffer, bars: number): Promise<number[]> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buffer = await ctx.decodeAudioData(bytes);
  return peaksFromChannel(buffer.getChannelData(0), bars);
}

/** fetch + decode helper; null when the fetch or decode fails (caller falls back). */
export async function loadAudioPeaks(src: string, bars: number): Promise<number[] | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    return await decodeAudioPeaks(await res.arrayBuffer(), bars);
  } catch {
    return null;
  }
}
