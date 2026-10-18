import type { TenantContext } from "@crm/core";
import type { ConversationListRow, ConversationView } from "@crm/core/messaging";
import { cn } from "@crm/design-system/lib/utils";
import { EmptyState } from "@crm/design-system/templates/empty-state";
import { hasPermission } from "@crm/permissions";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { AsideShell } from "@/components/aside-shell";
import { ConversationAside } from "@/components/conversation-aside";
import { ConversationPane } from "@/components/conversation-pane";
import { InboxFilters } from "@/components/inbox-filters";
import { InboxQueueList, type QueueRowView } from "@/components/inbox-queue-list";
import { NewConversationButton } from "@/components/new-conversation-button";
import { TICKET_STATUS } from "@/lib/ticket-status";
import {
  listConnectedChannels,
  listConversationCounts,
  listConversations,
  listSectors,
  listWahaConnections,
} from "@/server/services";
import { requireTenantContext } from "@/server/tenant";

// Reads the session + database → must never be prerendered at build time.
export const dynamic = "force-dynamic";

// IA spec §3: four tab views; pending/all are query modes of the "Ver" filter.
const TAB_VIEWS: ConversationView[] = ["queue", "mine", "snoozed", "closed"];
const FILTER_VIEWS: ConversationView[] = ["pending", "all"];
const VIEWS: ConversationView[] = [...TAB_VIEWS, ...FILTER_VIEWS];
const UNIFORM_STATUS_VIEWS = new Set<string>(["pending", "queue"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function queryString(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) sp.set(key, value);
  }
  return sp.toString();
}

interface MapDeps {
  view: ConversationView;
  showChannel: boolean;
  channelName: (id: string) => string | null;
  ts: Awaited<ReturnType<typeof getTranslations>>;
  t: Awaited<ReturnType<typeof getTranslations>>;
  format: Awaited<ReturnType<typeof getFormatter>>;
}

function toQueueRow(row: ConversationListRow, deps: MapDeps): QueueRowView {
  const snoozed =
    row.snoozedUntil !== null && row.snoozedUntil.getTime() > Date.now() ? row.snoozedUntil : null;
  return {
    id: row.id,
    title: row.contactDisplayName ?? row.contactChannelUserId,
    ticketNumber: row.ticketNumber,
    preview: row.lastMessagePreview,
    avatarUrl: row.contactAvatarUrl,
    mediaKind: row.lastMessageMediaKind,
    mediaLabel: row.lastMessageMediaKind
      ? deps.t.has(`mediaKinds.${row.lastMessageMediaKind}`)
        ? deps.t(`mediaKinds.${row.lastMessageMediaKind}`)
        : row.lastMessageMediaKind
      : null,
    waitingLabel:
      row.awaitingReply && row.lastMessageAt
        ? deps.t("awaitingFor", { time: deps.format.relativeTime(row.lastMessageAt) })
        : null,
    timeLabel: deps.format.relativeTime(row.lastMessageAt ?? row.createdAt),
    statusLabel: UNIFORM_STATUS_VIEWS.has(deps.view)
      ? null
      : deps.ts.has(row.status)
        ? deps.ts(row.status)
        : row.status,
    statusTone: TICKET_STATUS[row.status]?.tone ?? "neutral",
    sectionLabel: null,
    sectorName: row.sectorName,
    assigneeName: row.assigneeName,
    channelName: deps.showChannel ? deps.channelName(row.channelConnectionId) : null,
    awaitingReply: row.awaitingReply,
    unreadCount: row.unreadCount,
    snoozedUntil: snoozed?.toISOString() ?? null,
  };
}

/** Fila sections: Entrada (no sector) first, one bucket per sector after. */
function sectionize(opts: {
  mapped: QueueRowView[];
  rows: ConversationListRow[];
  sectors: { id: string; name: string }[];
  entryLabel: string;
}): QueueRowView[] {
  const { mapped, rows, sectors, entryLabel } = opts;
  const sectorIds = [...new Set(rows.map((r) => r.sectorId))].sort((a, b) => {
    if (a === null) return -1;
    if (b === null) return 1;
    const name = (id: string | null) => sectors.find((s) => s.id === id)?.name ?? "";
    return name(a).localeCompare(name(b));
  });
  return sectorIds.flatMap((sectorId) =>
    mapped
      .map((row, i) => ({ row, sectorId: rows[i]!.sectorId }))
      .filter((entry) => entry.sectorId === sectorId)
      .map(({ row }, i) => ({
        ...row,
        sectionLabel: i === 0 ? (sectors.find((s) => s.id === sectorId)?.name ?? entryLabel) : null,
      })),
  );
}

function inboxParams(sp: Record<string, string | undefined>) {
  const view: ConversationView = VIEWS.some((v) => v === sp.view)
    ? (sp.view as ConversationView)
    : "queue";
  const selectedId = sp.c && UUID_RE.test(sp.c) ? sp.c : undefined;
  // B1 jump: `around` re-renders the thread centered on a search hit.
  const aroundId = sp.around && UUID_RE.test(sp.around) ? sp.around : undefined;
  const params = {
    view,
    c: selectedId,
    q: sp.q,
    conn: sp.conn && UUID_RE.test(sp.conn) ? sp.conn : undefined,
    sector: sp.sector && UUID_RE.test(sp.sector) ? sp.sector : undefined,
    awaiting: sp.awaiting === "1" ? "1" : undefined,
  };
  return { view, selectedId, aroundId, params };
}

async function loadInboxLists(
  ctx: TenantContext,
  params: ReturnType<typeof inboxParams>["params"],
) {
  const [rows, counts, channels, sectors, wahaConnections] = await Promise.all([
    listConversations(ctx, {
      view: params.view,
      search: params.q,
      channelConnectionId: params.conn,
      sectorId: params.sector,
      awaitingReply: params.awaiting === "1",
    }),
    listConversationCounts(ctx),
    listConnectedChannels(ctx),
    listSectors(ctx),
    listWahaConnections(ctx),
  ]);
  return { rows, counts, channels, sectors, wahaConnections };
}

type InboxLists = Awaited<ReturnType<typeof loadInboxLists>>;

/** Queue rows plus the discriminating markers (spec docs/product/inbox.md). */
function buildInboxRows(lists: InboxLists, deps: Pick<MapDeps, "view" | "ts" | "t" | "format">) {
  const { rows, channels, sectors } = lists;
  // A badge only renders when it tells rows apart — channel if >1 connected,
  // assignee when the list mixes owners (never inside Minhas or the unassigned Fila).
  const showChannel = channels.length > 1;
  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? null;
  const distinctOwners = new Set(rows.map((r) => r.assigneeId).filter(Boolean)).size;
  const showAssignee = deps.view !== "mine" && deps.view !== "queue" && distinctOwners > 1;
  const mapped = rows.map((row) => toQueueRow(row, { ...deps, showChannel, channelName }));
  const display =
    deps.view === "queue"
      ? sectionize({ mapped, rows, sectors, entryLabel: deps.t("entryQueue") })
      : mapped;
  return { display, showChannel, showAssignee };
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const t = await getTranslations("inbox");
  const ts = await getTranslations("ticketStatus");
  const format = await getFormatter();
  const ctx = await requireTenantContext();
  const { view, selectedId, aroundId, params } = inboxParams(await searchParams);
  // Row links append their own `c` — the preserved query carries filters only.
  const query = queryString({ ...params, c: undefined });

  const lists = await loadInboxLists(ctx, params);
  const { counts, channels, sectors, wahaConnections } = lists;
  const { display, showChannel, showAssignee } = buildInboxRows(lists, { view, ts, t, format });

  return (
    <main className="h-workbench flex" data-testid="inbox-workbench">
      <section
        className={cn(
          "border-line lg:w-inbox-list-sm wide:w-inbox-list w-full flex-col border-r lg:flex",
          selectedId ? "hidden lg:flex" : "flex",
        )}
        aria-label={t("viewsAria")}
      >
        <div className="flex items-center justify-between gap-2 px-3 pt-4">
          <h1 className="font-display tracking-card text-ink-strong text-lg font-medium">
            {t("title")}
          </h1>
          {hasPermission(ctx.role, { messaging: ["write"] }) && (
            <NewConversationButton connections={wahaConnections} />
          )}
        </div>

        <nav className="flex gap-1 overflow-x-auto border-b px-2" aria-label={t("viewsAria")}>
          {TAB_VIEWS.map((v) => (
            <Link
              key={v}
              href={`/app/inbox?${queryString({ ...params, view: v, c: undefined })}`}
              className={cn(
                "text-ink-muted hover:text-ink -mb-px flex shrink-0 items-center gap-1 border-b-2 border-transparent px-2.5 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                view === v && "border-line-accent text-ink",
              )}
              aria-current={view === v ? "page" : undefined}
            >
              {t(`views.${v}`)}
              <span className="text-ink-subtle text-xs">{counts[v]}</span>
            </Link>
          ))}
        </nav>

        <InboxFilters
          params={params}
          channels={channels.map(({ id, name }) => ({ id, name }))}
          sectors={sectors.map(({ id, name }) => ({ id, name }))}
        />

        <div className="min-h-0 flex-1 overflow-y-auto pt-2">
          {display.length === 0 ? (
            <EmptyState icon="inbox" title={t(`empty.${view}`)} />
          ) : (
            <InboxQueueList
              rows={display}
              selectedId={selectedId}
              query={query}
              showAssignee={showAssignee}
              showChannel={showChannel}
            />
          )}
        </div>
      </section>

      <section
        className={cn(
          "min-w-0 flex-1 flex-col overflow-y-auto p-4 lg:p-6",
          selectedId ? "flex" : "hidden lg:flex",
        )}
      >
        {selectedId ? (
          <>
            <Link
              href={`/app/inbox?${queryString({ ...params, c: undefined })}`}
              className="text-ink-muted mb-3 text-sm underline lg:hidden"
            >
              {t("backToList")}
            </Link>
            <ConversationPane
              conversationId={selectedId}
              around={aroundId}
              backHref={`/app/inbox?${queryString(params)}`}
            />
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState icon="inbox" title={t("selectConversation")} />
          </div>
        )}
      </section>

      {selectedId && (
        <AsideShell openLabel={t("openAside")} closeLabel={t("closeAside")}>
          <ConversationAside conversationId={selectedId} />
        </AsideShell>
      )}
    </main>
  );
}
