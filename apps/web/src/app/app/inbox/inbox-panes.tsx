import type { ConversationView } from "@crm/core/messaging";
import { cn } from "@crm/design-system/lib/utils";
import { EmptyState } from "@crm/design-system/templates/empty-state";
import Link from "next/link";
import type { getTranslations } from "next-intl/server";

import { ConversationPane } from "@/components/conversation-pane";
import { InboxQueueList, type QueueRowView } from "@/components/inbox-queue-list";
import { NewConversationButton } from "@/components/new-conversation-button";
import type { listWahaConnections } from "@/server/services";

// IA spec §3: four tab views; pending/all are query modes of the "Ver" filter.
export const TAB_VIEWS: ConversationView[] = ["queue", "mine", "snoozed", "closed"];

export function queryString(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) sp.set(key, value);
  }
  return sp.toString();
}

type T = Awaited<ReturnType<typeof getTranslations>>;
type Params = Record<string, string | undefined>;

export function ViewTabs({
  view,
  params,
  counts,
  t,
}: {
  view: ConversationView;
  params: Params;
  counts: Record<string, number>;
  t: T;
}) {
  return (
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
  );
}

export function DetailPane({
  selectedId,
  aroundId,
  params,
  t,
}: {
  selectedId: string | undefined;
  aroundId: string | undefined;
  params: Params;
  t: T;
}) {
  return (
    <section
      className={cn(
        "min-w-0 flex-1 flex-col overflow-y-auto p-4 lg:p-6",
        selectedId ? "flex" : "hidden lg:flex",
      )}
    >
      {selectedId ? (
        <DetailBody selectedId={selectedId} aroundId={aroundId} params={params} t={t} />
      ) : (
        <div className="flex h-full items-center justify-center">
          <EmptyState icon="inbox" title={t("selectConversation")} />
        </div>
      )}
    </section>
  );
}

function DetailBody({
  selectedId,
  aroundId,
  params,
  t,
}: {
  selectedId: string;
  aroundId: string | undefined;
  params: Params;
  t: T;
}) {
  return (
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
  );
}

export function InboxHeader({
  t,
  connections,
  canWrite,
}: {
  t: T;
  connections: Awaited<ReturnType<typeof listWahaConnections>>;
  canWrite: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 pt-4">
      <h1 className="font-display tracking-card text-ink-strong text-lg font-medium">
        {t("title")}
      </h1>
      {canWrite && <NewConversationButton connections={connections} />}
    </div>
  );
}

export function QueueBody({
  display,
  view,
  selectedId,
  params,
  flags,
  t,
}: {
  display: QueueRowView[];
  view: ConversationView;
  selectedId: string | undefined;
  params: Params;
  flags: { showAssignee: boolean; showChannel: boolean };
  t: T;
}) {
  // Row links append their own `c` — the preserved query carries filters only.
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pt-2">
      {display.length === 0 ? (
        <EmptyState icon="inbox" title={t(`empty.${view}`)} />
      ) : (
        <InboxQueueList
          rows={display}
          selectedId={selectedId}
          query={queryString({ ...params, c: undefined })}
          showAssignee={flags.showAssignee}
          showChannel={flags.showChannel}
        />
      )}
    </div>
  );
}
