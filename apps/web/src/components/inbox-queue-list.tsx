"use client";

import { Avatar } from "@crm/design-system/components/avatar";
import { Badge } from "@crm/design-system/components/badge";
import { Icon, type IconName } from "@crm/design-system/components/icon";
import { cn } from "@crm/design-system/lib/utils";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import { LocalDateTime } from "@/components/local-date-time";

/** Serialized row — preformatted server-side, no Dates cross the boundary. */
export interface QueueRowView {
  id: string;
  title: string;
  ticketNumber: number;
  preview: string | null;
  avatarUrl: string | null;
  /** Last channel message kind — icon + label replace the `[media]` bracket. */
  mediaKind: string | null;
  /** Localized media label ("Áudio") used when the raw preview is `[media]`. */
  mediaLabel: string | null;
  /** "Aguardando há X" — only when the last message is inbound. */
  waitingLabel: string | null;
  timeLabel: string;
  statusLabel: string | null;
  statusTone: "warning" | "success" | "neutral";
  /** Section header rendered when this value changes between rows (Fila). */
  sectionLabel: string | null;
  sectorName: string | null;
  assigneeName: string | null;
  channelName: string | null;
  awaitingReply: boolean;
  /** ISO instant the snooze ends — formatted client-side (browser TZ). */
  snoozedUntil: string | null;
  /** Inbound messages newer than the viewer's read cursor. */
  unreadCount: number;
}

const MEDIA_ICONS: Record<string, IconName> = {
  audio: "mic",
  image: "image",
  video: "video",
  document: "file",
  sticker: "sticker",
};

/** Second line — media icon + preview (localized kind label over `[media]`). */
function RowPreviewLine({ row }: { row: QueueRowView }) {
  if (!row.preview && !row.mediaKind) return null;
  return (
    <p
      className={cn(
        "flex items-center gap-1 truncate text-sm",
        row.unreadCount > 0 ? "text-ink font-medium" : "text-ink-muted",
      )}
    >
      {row.mediaKind && (
        <Icon name={MEDIA_ICONS[row.mediaKind] ?? "file"} className="size-3.5 shrink-0" />
      )}
      <span className="truncate">
        {row.mediaKind && row.preview === "[media]" ? row.mediaLabel : row.preview}
      </span>
    </p>
  );
}

/** Third line — waiting timer, status badge, sector/channel/assignee chips. */
function RowMetaLine({
  row,
  showAssignee,
  showChannel,
}: {
  row: QueueRowView;
  showAssignee: boolean;
  showChannel: boolean;
}) {
  const t = useTranslations("inbox");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {row.waitingLabel && (
        <span className="text-warning flex items-center gap-1 text-xs">
          <Icon name="timer" className="size-3" />
          {row.waitingLabel}
        </span>
      )}
      {row.statusLabel && <Badge tone={row.statusTone}>{row.statusLabel}</Badge>}
      {[
        row.sectorName,
        showChannel ? row.channelName : null,
        showAssignee ? row.assigneeName : null,
      ]
        .filter((v): v is string => v !== null)
        .map((label) => (
          <span
            key={label}
            className="border-line text-ink-muted rounded-md border px-1.5 py-0.5 text-xs"
          >
            {label}
          </span>
        ))}
      {row.snoozedUntil && (
        <span className="text-ink-muted text-xs">
          {t.rich("snoozedUntil", {
            date: () => <LocalDateTime date={row.snoozedUntil!} timeStyle="short" />,
          })}
        </span>
      )}
    </div>
  );
}

function RowTitleLine({ row, awaitingLabel }: { row: QueueRowView; awaitingLabel: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Avatar src={row.avatarUrl ?? undefined} name={row.title} size="sm" />
      <span className="flex min-w-0 items-center gap-2">
        {row.awaitingReply && (
          <span className="bg-signal h-2 w-2 shrink-0 rounded-full" title={awaitingLabel} />
        )}
        <span className={cn("truncate", row.unreadCount > 0 ? "font-semibold" : "font-medium")}>
          {row.title}
        </span>
        <span className="text-ink-muted shrink-0 text-xs">#{row.ticketNumber}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {row.unreadCount > 0 && (
          <Badge variant="solid" tone="accent" size="sm" data-testid="unread-count">
            {row.unreadCount > 99 ? "99+" : row.unreadCount}
          </Badge>
        )}
        <span className="text-ink-muted text-xs">{row.timeLabel}</span>
      </span>
    </div>
  );
}

function QueueRowItem({
  row,
  href,
  selected,
  cursor,
  showAssignee,
  showChannel,
  awaitingLabel,
}: {
  row: QueueRowView;
  href: string;
  selected: boolean;
  cursor: boolean;
  showAssignee: boolean;
  showChannel: boolean;
  awaitingLabel: string;
}) {
  return (
    <Link
      href={href}
      data-selected={selected || undefined}
      className={cn(
        "hover:bg-raised/50 block space-y-1 px-3 py-3 transition-colors",
        selected && "bg-raised/60",
        cursor && "shadow-focus",
      )}
    >
      <RowTitleLine row={row} awaitingLabel={awaitingLabel} />
      <RowPreviewLine row={row} />
      <RowMetaLine row={row} showAssignee={showAssignee} showChannel={showChannel} />
    </Link>
  );
}

/** j/k move the cursor, Enter opens the row under it (ignored while typing in a field). */
function useQueueCursor({
  rows,
  selectedId,
  query,
}: {
  rows: QueueRowView[];
  selectedId: string | undefined;
  query: string;
}) {
  const router = useRouter();
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      rows.findIndex((r) => r.id === selectedId),
    ),
  );
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key !== "j" && event.key !== "k" && event.key !== "Enter") return;
      event.preventDefault();
      setCursor((current) => {
        if (event.key === "Enter") {
          const id = ids[current];
          if (id) router.push(`/app/inbox?${query}&c=${id}`);
          return current;
        }
        const next = current + (event.key === "j" ? 1 : -1);
        return Math.min(ids.length - 1, Math.max(0, next));
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ids, query, router]);
  return cursor;
}

export function InboxQueueList({
  rows,
  selectedId,
  query,
  showAssignee,
  showChannel,
}: {
  rows: QueueRowView[];
  selectedId: string | undefined;
  /** Query string preserving the active filters — selection joins as `c`. */
  query: string;
  showAssignee: boolean;
  showChannel: boolean;
}) {
  const t = useTranslations("inbox");
  const cursor = useQueueCursor({ rows, selectedId, query });

  return (
    <ul className="divide-line divide-y" data-testid="conversation-list">
      {rows.map((row, index) => (
        <li key={row.id}>
          {row.sectionLabel && (
            <div className="bg-raised/40 text-ink-muted px-3 py-1.5 text-xs font-medium uppercase">
              {row.sectionLabel}
            </div>
          )}
          <QueueRowItem
            row={row}
            href={`/app/inbox?${query}&c=${row.id}`}
            selected={row.id === selectedId}
            cursor={index === cursor}
            showAssignee={showAssignee}
            showChannel={showChannel}
            awaitingLabel={t("awaitingReply")}
          />
        </li>
      ))}
    </ul>
  );
}
