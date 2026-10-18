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

/**
 * Center column of the inbox workbench — ticket header, message thread,
 * ticket actions, AI cards and composer. Self-contained: fetches its own
 * data so the inbox page can mount it for the selected `?c=` id.
 */
export async function ConversationPane({
  conversationId,
  around,
  backHref,
}: {
  conversationId: string;
  /** Search-jump target (B1): renders a ±radius window instead of the tail. */
  around?: string | undefined;
  /** `/app/inbox?...` with `around` stripped — the "back to end" link. */
  backHref: string;
}) {
  const t = await getTranslations("inbox");
  const ts = await getTranslations("ticketStatus");
  const ctx = await requireTenantContext();
  const conversation = await findConversation(ctx, conversationId);
  if (!conversation) {
    return (
      <Card className="min-w-0 flex-1">
        <EmptyState icon="inbox" title={t("notFound")} />
      </Card>
    );
  }
  const [{ rows: messages, windowed }, members, sectors, macros] = await Promise.all([
    loadMessages(ctx, conversationId, around),
    listMembers(ctx),
    listSectors(ctx),
    listMacros(ctx),
  ]);
  const { isViewer, canWork, showDrafts } = threadAccess(ctx, conversation);
  const { cards, lastInboundAt, hasCredential } = await loadDrafts(ctx, conversationId, showDrafts);

  return (
    <Card bodyClassName="space-y-4" className="min-w-0 flex-1">
      <ConversationReadMarker
        conversationId={conversationId}
        lastInboundKey={lastInboundIdOf(messages)}
      />
      <TicketHeader conversation={conversation} t={t} ts={ts} />

      {conversation.precededById && (
        <Link
          href={`/app/inbox/${conversation.precededById}`}
          className="text-ink-muted hover:text-ink block rounded-md border border-dashed px-3 py-2 text-center text-xs"
          data-testid="previous-ticket"
        >
          {t("previousTicket", {
            number: conversation.precededTicketNumber
              ? ` #${conversation.precededTicketNumber}`
              : "",
          })}
        </Link>
      )}

      {windowed && (
        <div
          className="border-line bg-raised flex items-center justify-between rounded-md border px-3 py-1.5 text-xs"
          data-testid="search-window"
        >
          <span className="text-ink-muted">{t("searchWindowNotice")}</span>
          <Link href={backHref} className="text-ink underline underline-offset-2">
            {t("backToEnd")}
          </Link>
          <JumpAnchor messageId={around ?? ""} />
        </div>
      )}

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

      <TicketActions
        conversation={conversation}
        userId={ctx.userId}
        members={members}
        sectors={sectors}
        canWork={canWork}
        isResolved={conversation.status === "resolved"}
        isClosed={conversation.status === "closed"}
        isViewer={isViewer}
      />

      {showDrafts &&
        cards.map((card) =>
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
        )}

      {!isViewer && (
        <Composer
          conversationId={conversation.id}
          disabled={!canWork}
          draftsEnabled={hasCredential}
          macros={macros}
          canProposeMacro={
            hasPermission(ctx.role, { messaging: ["write"] }) &&
            ctx.role !== "manager" &&
            ctx.role !== "admin" &&
            ctx.role !== "owner" &&
            !ctx.isPlatformAdmin
          }
        />
      )}
    </Card>
  );
}
