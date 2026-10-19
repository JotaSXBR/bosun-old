import { Badge } from "@crm/design-system/components/badge";
import { Card } from "@crm/design-system/components/card";
import { hasPermission } from "@crm/permissions";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { ContactFicha } from "@/components/contact-ficha";
import { ConversationLeadPanel } from "@/components/conversation-lead-panel";
import { LocalDateTime } from "@/components/local-date-time";
import { pickProfileMetadata } from "@/lib/contact-profile";
import { TICKET_STATUS } from "@/lib/ticket-status";
import { findConversation } from "@/server/find-conversation";
import {
  getConversationDeal,
  getConversationLabels,
  listContactLabels,
  listContactTickets,
  listFunnelsWithStages,
  listOrgLabels,
} from "@/server/services";
import { requireTenantContext } from "@/server/tenant";

type HistoryRow = Awaited<ReturnType<typeof listContactTickets>>[number];

async function ContactHistoryCard({ history }: { history: HistoryRow[] }) {
  const t = await getTranslations("inbox");
  const ts = await getTranslations("ticketStatus");
  return (
    <Card bodyClassName="space-y-2 text-sm" title={t("contactHistory")} className="mt-4">
      {history.length === 0 ? (
        <p className="text-ink-muted text-xs">{t("contactHistoryEmpty")}</p>
      ) : (
        <ul className="space-y-2" data-testid="contact-history">
          {history.map((ticket) => (
            <li key={ticket.id}>
              <Link
                href={`/app/inbox?c=${ticket.id}`}
                className="hover:bg-raised/50 -mx-2 flex items-center justify-between gap-2 rounded-md px-2 py-1.5"
              >
                <span className="min-w-0">
                  <span className="text-ink block truncate text-xs font-medium">
                    #{ticket.ticketNumber} · <LocalDateTime date={ticket.createdAt} />
                  </span>
                  {ticket.lastMessagePreview && (
                    <span className="text-ink-muted block truncate text-xs">
                      {ticket.lastMessagePreview}
                    </span>
                  )}
                </span>
                <Badge tone={TICKET_STATUS[ticket.status]?.tone ?? "neutral"} size="sm">
                  {ts.has(ticket.status) ? ts(ticket.status) : ticket.status}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Right column of the inbox workbench — today the lead/deal panel; the full
 * contact ficha (E2, docs/product/inbox.md) drops into this same slot.
 * Self-contained: fetches its own data for the selected `?c=` id.
 */
export async function ConversationAside({ conversationId }: { conversationId: string }) {
  const t = await getTranslations("inbox");
  const ctx = await requireTenantContext();
  const conversation = await findConversation(ctx, conversationId);
  if (!conversation) return <p className="text-ink-muted text-sm">{t("notFound")}</p>;
  const [deal, funnels, labels, conversationLabels, contactLabels, history] = await Promise.all([
    getConversationDeal(ctx, conversationId),
    listFunnelsWithStages(ctx),
    listOrgLabels(ctx),
    getConversationLabels(ctx, conversationId),
    listContactLabels(ctx, conversation.contactId),
    listContactTickets(ctx, conversation.contactId, conversationId),
  ]);
  return (
    <>
      <ContactFicha
        contactId={conversation.contactId}
        conversationId={conversation.id}
        displayName={conversation.contactDisplayName ?? ""}
        channelUserId={conversation.contactChannelUserId}
        avatarUrl={conversation.contactAvatarUrl}
        metadata={pickProfileMetadata(conversation.contactMetadata)}
        contactLabels={contactLabels}
        conversationLabels={conversationLabels}
        allLabels={labels}
        canWrite={hasPermission(ctx.role, { messaging: ["write"] })}
        canManageLabels={hasPermission(ctx.role, { leads: ["manage"] })}
      />
      <ConversationLeadPanel
        conversationId={conversation.id}
        contactName={conversation.contactDisplayName ?? conversation.contactChannelUserId}
        deal={deal}
        funnels={funnels}
        canWrite={ctx.role !== "viewer"}
      />
      <ContactHistoryCard history={history} />
    </>
  );
}
