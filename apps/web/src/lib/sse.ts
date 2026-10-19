"use client";

// Shared org-scoped SSE stream — one EventSource per browser tab feeds
// every subscriber (inbox refresh, presence indicator, ...). The stream
// itself is tenant-filtered server-side; clients filter by event type.
export type DomainEvent = Record<string, unknown> & { type?: string };

let source: EventSource | null = null;
const listeners = new Set<(event: DomainEvent) => void>();

function ensureSource(): EventSource {
  if (source) return source;
  source = new EventSource("/api/conversations/stream");
  source.onmessage = (raw) => {
    let event: DomainEvent;
    try {
      event = JSON.parse(String(raw.data)) as DomainEvent;
    } catch {
      return;
    }
    for (const listener of listeners) listener(event);
  };
  return source;
}

/**
 * Subscribe to the org event stream. Returns an unsubscribe; the underlying
 * EventSource closes once the last subscriber leaves.
 */
export function subscribeToDomainEvents(listener: (event: DomainEvent) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  listeners.add(listener);
  ensureSource();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && source) {
      source.close();
      source = null;
    }
  };
}
