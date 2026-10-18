"use client";

// In-thread search (B1): the input lives in the pane header; picking a hit
// navigates to `?around=<id>#msg-<id>` — the pane re-renders the ±radius
// window server-side and JumpAnchor scrolls the bubble into view.
import type { MessageSearchHit } from "@crm/core/messaging";
import { Icon } from "@crm/design-system/components/icon";
import { useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { searchMessagesAction } from "@/server/actions/messaging";

/** Debounced search plus open/close state of the hit dropdown (closed on outside click). */
function useThreadSearch(conversationId: string) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MessageSearchHit[] | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const timer = setTimeout(() => {
      searchMessagesAction({ conversationId, query: q })
        .then((r) => {
          if (r.ok) {
            setHits(r.hits);
            setOpen(true);
          }
        })
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, conversationId]);

  // Click-away closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return { query, setQuery, hits, setHits, open, setOpen, boxRef };
}

export function ThreadSearch({ conversationId }: { conversationId: string }) {
  const t = useTranslations("inbox");
  const format = useFormatter();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { query, setQuery, hits, setHits, open, setOpen, boxRef } = useThreadSearch(conversationId);

  const jumpTo = (hit: MessageSearchHit) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("around", hit.id);
    setOpen(false);
    setQuery("");
    setHits(null);
    router.push(`/app/inbox?${params.toString()}#msg-${hit.id}`, { scroll: false });
  };

  return (
    <div ref={boxRef} className="relative">
      <Icon
        name="search"
        className="text-ink-subtle pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
      />
      <input
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!e.target.value.trim()) setHits(null);
        }}
        onFocus={() => hits !== null && setOpen(true)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        placeholder={t("searchPlaceholder")}
        aria-label={t("searchPlaceholder")}
        className="border-line bg-page text-ink placeholder:text-ink-subtle focus:border-line-accent w-44 rounded-md border py-1 pr-2 pl-7 text-xs outline-none"
        data-testid="thread-search"
      />
      {open && hits !== null && (
        <div
          className="bg-raised text-ink shadow-raised absolute top-full right-0 z-20 mt-1 w-72 overflow-hidden rounded-md border"
          data-testid="thread-search-results"
        >
          {hits.length === 0 ? (
            <p className="text-ink-muted px-3 py-2 text-xs">{t("searchNoResults")}</p>
          ) : (
            <ul>
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    className="hover:bg-page block w-full px-3 py-2 text-left"
                    onClick={() => jumpTo(hit)}
                  >
                    <span className="text-ink-subtle block text-xs">
                      {format.dateTime(hit.sentAt ?? hit.createdAt, {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                      {" · "}
                      {hit.direction === "outbound" ? t("searchOutbound") : t("searchInbound")}
                    </span>
                    <span className="line-clamp-2 text-xs">{hit.preview ?? "…"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * After the ?around navigation re-renders the window, scrolls the target
 * bubble to the center of the viewport (hash-scroll alone is unreliable
 * under RSC streaming).
 */
export function JumpAnchor({ messageId }: { messageId: string }) {
  useEffect(() => {
    document
      .getElementById(`msg-${messageId}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [messageId]);
  return null;
}
