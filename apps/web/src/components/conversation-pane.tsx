import type { TenantContext } from "@crm/core";
import { NotFoundError } from "@crm/core";
import { draftPayloadSchema } from "@crm/core/drafts";
import type { ConversationDetailRow, MessageWithAuthorRow } from "@crm/core/messaging";
import { canInspectMessageHistory } from "@crm/core/messaging";
import type { AgentSuggestionRow } from "@crm/core/suggestions";
import { Badge } from "@crm/design-system/components/badge";
import { Card } from "@crm/design-system/components/card";
import { EmptyState } from "@crm/design-system/templates/empty-state";
import { captureException } from "@crm/observability";
import { hasPermission } from "@crm/permissions";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ComponentProps } from "react";

import { Composer } from "@/components/composer";
import { ConversationReadMarker } from "@/components/conversation-read-marker";
import { DraftCard } from "@/components/draft-card";
import { LocalDateTime } from "@/components/local-date-time";
import { MessageItem } from "@/components/message-item";
import { NudgeCard } from "@/components/nudge-card";
import { PresenceIndicator } from "@/components/presence-indicator";
import { JumpAnchor, ThreadSearch } from "@/components/thread-search";
import { TicketActions } from "@/components/ticket-actions";
import { TICKET_STATUS } from "@/lib/ticket-status";
import { findConversation } from "@/server/find-conversation";
import {
  getLastInboundAt,
  hasLlmCredential,
  listMacros,
  listMembers,
  listMessages,
  listMessagesAround,
  listSectors,
  listThreadCardsForConversation,
} from "@/server/services";
import { requireTenantContext } from "@/server/tenant";

function TicketHeader({
  conversation,
  t,
  ts,
}: {
  conversation: ConversationDetailRow;
  t: Awaited<ReturnType<typeof getTranslations>>;
  ts: Awaited<ReturnType<typeof getTranslations>>;
}) {
  const status = TICKET_STATUS[conversation.status];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="font-display tracking-card text-ink-strong text-lg font-medium">
          #{conversation.ticketNumber} ·{" "}
          {conversation.contactDisplayName ?? conversation.contactChannelUserId}{" "}
          <PresenceIndicator conversationId={conversation.id} />
        </div>
        <div className="flex items-center gap-3">
          <ThreadSearch conversationId={conversation.id} />
          <Badge tone={status?.tone ?? "neutral"}>
            {ts.has(conversation.status) ? ts(conversation.status) : conversation.status}
          </Badge>
        </div>
      </div>
      <p className="text-ink-muted text-sm">
        {t.rich("ticketSeq", {
          seq: conversation.ticketSeq,
          date: () => <LocalDateTime date={conversation.createdAt} timeStyle="medium" />,
        })}
        {conversation.assigneeName && <> · {conversation.assigneeName}</>}
        {conversation.sectorName && <> · {conversation.sectorName}</>}
      </p>
    </div>
  );
}

type Thread = { rows: MessageWithAuthorRow[]; windowed: boolean };

/**
 * Jump mode: ?around=<id> swaps the tail for a centered window. A stale or
 * foreign id falls back to the tail instead of erroring the pane.
 */
async function loadMessages(
  ctx: TenantContext,
  conversationId: string,
  around: string | undefined,
): Promise<Thread> {
  const tail = () => listMessages(ctx, conversationId).then((rows) => ({ rows, windowed: false }));
  if (!around) return tail();
  return listMessagesAround(ctx, conversationId, around)
    .then((rows) => ({ rows, windowed: true }))
    .catch((error: unknown) => {
      if (error instanceof NotFoundError) return tail();
      throw error;
    });
}

function threadAccess(ctx: TenantContext, conversation: ConversationDetailRow) {
  const isViewer = ctx.role === "viewer";
  const canWork =
    !isViewer && conversation.status !== "resolved" && conversation.status !== "closed";
  // Drafts only render on a workable thread — a pending card on a
  // resolved ticket would sit disabled forever.
  const showDrafts = canWork && hasPermission(ctx.role, { messaging: ["write"] });
  return { isViewer, canWork, showDrafts };
}

async function loadDrafts(ctx: TenantContext, conversationId: string, showDrafts: boolean) {
  if (!showDrafts) {
    return { cards: [] as AgentSuggestionRow[], lastInboundAt: null, hasCredential: false };
  }
  const [cards, lastInboundAt, hasCredential] = await Promise.all([
    listThreadCardsForConversation(ctx, conversationId).catch((error: unknown) => {
      captureException(error, { action: "listThreadCardsForConversation" });
      return [];
    }),
    getLastInboundAt(ctx, conversationId),
    hasLlmCredential(ctx),
  ]);
  return { cards, lastInboundAt, hasCredential };
}

/** Live-read key: a new inbound while the thread is open re-fires the read marker. */
const lastInboundIdOf = (messages: MessageWithAuthorRow[]) =>
  messages.findLast((m) => m.direction === "inbound")?.id ?? null;

type Translator = Awaited<ReturnType<typeof getTranslations>>;

function PreviousTicketLink({
  conversation,
  t,
}: {
  conversation: ConversationDetailRow;
  t: Translator;
}) {
  if (!conversation.precededById) return null;
  return (
    <Link
      href={`/app/inbox/${conversation.precededById}`}
      className="text-ink-muted hover:text-ink block rounded-md border border-dashed px-3 py-2 text-center text-xs"
      data-testid="previous-ticket"
    >
      {t("previousTicket", {
        number: conversation.precededTicketNumber ? ` #${conversation.precededTicketNumber}` : "",
      })}
    </Link>
  );
}

function SearchWindowNotice({
  around,
  backHref,
  t,
}: {
  around: string;
  backHref: string;
  t: Translator;
}) {
  return (
    <div
      className="border-line bg-raised flex items-center justify-between rounded-md border px-3 py-1.5 text-xs"
      data-testid="search-window"
    >
      <span className="text-ink-muted">{t("searchWindowNotice")}</span>
      <Link href={backHref} className="text-ink underline underline-offset-2">
        {t("backToEnd")}
      </Link>
      <JumpAnchor messageId={around} />
    </div>
  );
}

function ThreadCards({
  cards,
  lastInboundAt,
}: {
  cards: AgentSuggestionRow[];
  lastInboundAt: Date | null;
}) {
  return cards.map((card) =>
    card.targetType === "nudge" ? (
      <NudgeCard key={card.id} suggestionId={card.id} rationale={card.rationale} />
    ) : (
      <DraftCard
        key={card.id}
        suggestionId={card.id}
        body={draftPayloadSchema.safeParse(card.payload).data?.body ?? ""}
        rationale={card.rationale}
        stale={lastInboundAt !== null && lastInboundAt > card.createdAt}
      />
    ),
  );
}

const canProposeMacro = (ctx: TenantContext) =>
  hasPermission(ctx.role, { messaging: ["write"] }) &&
  ctx.role !== "manager" &&
  ctx.role !== "admin" &&
  ctx.role !== "owner" &&
  !ctx.isPlatformAdmin;

async function loadPaneData(
  ctx: TenantContext,
  conversation: ConversationDetailRow,
  around: string | undefined,
) {
  const [{ rows: messages, windowed }, members, sectors, macros] = await Promise.all([
    loadMessages(ctx, conversation.id, around),
    listMembers(ctx),
    listSectors(ctx),
    listMacros(ctx),
  ]);
  const access = threadAccess(ctx, conversation);
  const drafts = await loadDrafts(ctx, conversation.id, access.showDrafts);
  return { messages, windowed, members, sectors, macros, ...drafts, ...access };
}

const NotFoundCard = ({ title }: { title: string }) => (
  <Card className="min-w-0 flex-1">
    <EmptyState icon="inbox" title={title} />
  </Card>
);

type PaneProps = {
  conversationId: string;
  /** Search-jump target (B1): renders a ±radius window instead of the tail. */
  around?: string | undefined;
  /** `/app/inbox?...` with `around` stripped — the "back to end" link. */
  backHref: string;
};

function MessageList({
  ctx,
  messages,
  members,
  sectors,
  canWork,
}: {
  ctx: TenantContext;
  messages: MessageWithAuthorRow[];
  members: ComponentProps<typeof MessageItem>["members"];
  sectors: ComponentProps<typeof MessageItem>["sectors"];
  canWork: boolean;
}) {
  return (
    <ul className="space-y-2" data-testid="message-thread">
      {messages.map((msg) => (
        <MessageItem
          key={msg.id}
          msg={msg}
          members={members}
          sectors={sectors}
          currentUserId={ctx.userId}
          canInspect={canInspectMessageHistory(ctx)}
          canInteract={canWork}
        />
      ))}
    </ul>
  );
}

/**
 * Center column of the inbox workbench — ticket header, message thread,
 * ticket actions, AI cards and composer. Self-contained: fetches its own
 * data so the inbox page can mount it for the selected `?c=` id.
 */
export async function ConversationPane({ conversationId, around, backHref }: PaneProps) {
  const t = await getTranslations("inbox");
  const ts = await getTranslations("ticketStatus");
  const ctx = await requireTenantContext();
  const conversation = await findConversation(ctx, conversationId);
  if (!conversation) return <NotFoundCard title={t("notFound")} />;
  const d = await loadPaneData(ctx, conversation, around);

  return (
    <Card bodyClassName="space-y-4" className="min-w-0 flex-1">
      <ConversationReadMarker
        conversationId={conversationId}
        lastInboundKey={lastInboundIdOf(d.messages)}
      />
      <TicketHeader conversation={conversation} t={t} ts={ts} />
      <PreviousTicketLink conversation={conversation} t={t} />
      {d.windowed && <SearchWindowNotice around={around ?? ""} backHref={backHref} t={t} />}
      <MessageList
        ctx={ctx}
        messages={d.messages}
        members={d.members}
        sectors={d.sectors}
        canWork={d.canWork}
      />
      <TicketActions
        conversation={conversation}
        userId={ctx.userId}
        members={d.members}
        sectors={d.sectors}
        canWork={d.canWork}
        isResolved={conversation.status === "resolved"}
        isClosed={conversation.status === "closed"}
        isViewer={d.isViewer}
      />
      {d.showDrafts && <ThreadCards cards={d.cards} lastInboundAt={d.lastInboundAt} />}
      {!d.isViewer && (
        <Composer
          conversationId={conversation.id}
          disabled={!d.canWork}
          draftsEnabled={d.hasCredential}
          macros={d.macros}
          canProposeMacro={canProposeMacro(ctx)}
        />
      )}
    </Card>
  );
}
