// Server-rendered message bubble — interactive affordances are the client
// islands in ./message-extras, ./message-menu and ./message-context-menu.
import type { MessageContent, MessageWithAuthorRow } from "@crm/core/messaging";
import type { OrgMember } from "@crm/core/organizations";
import type { TeamWithMembers } from "@crm/core/teams";
import { cn } from "@crm/design-system/lib/utils";
import { getTranslations } from "next-intl/server";

import { LocalDateTime } from "@/components/local-date-time";
import { MessageContextMenu } from "@/components/message-context-menu";
import { EditedIndicator, ResendButton, RevokedActions } from "@/components/message-extras";
import { MediaContent } from "@/components/message-media";
import { MessageMenu } from "@/components/message-menu";
import { ReactionChips } from "@/components/reaction-chips";

type T = Awaited<ReturnType<typeof getTranslations>>;

function messageText(content: unknown, t: T): string {
  const c = content as { type?: string; text?: string; caption?: string };
  return c.text ?? c.caption ?? t("unknownType", { type: c.type ?? t("fallbackType") });
}

/** WhatsApp-style ticks: ✓ enviada · ✓✓ entregue (cinza) · ✓✓ lida (azul). */
function MessageTicks({ status, t }: { status: string; t: T }) {
  if (status === "read") {
    return (
      <span className="text-info" title={t("tickRead")} data-testid="tick-read">
        ✓✓
      </span>
    );
  }
  if (status === "delivered") {
    return (
      <span className="opacity-80" title={t("tickDelivered")}>
        ✓✓
      </span>
    );
  }
  if (status === "sent" || status === "queued") {
    return (
      <span className="opacity-80" title={t("tickSent")}>
        ✓
      </span>
    );
  }
  return null;
}

/** Quoted message preview rendered above the bubble content. */
function QuoteBlock({
  quoted,
  outbound,
  t,
}: {
  quoted: NonNullable<MessageWithAuthorRow["quoted"]>;
  outbound: boolean;
  t: T;
}) {
  return (
    <div
      className={cn(
        "mb-1 rounded-md border-l-4 px-2 py-1 text-xs",
        outbound ? "border-ink-on-signal/60 bg-ink-on-signal/15" : "border-ink-muted/50 bg-page/60",
      )}
      data-testid="quoted-message"
    >
      <p className="font-medium">
        {quoted.direction === "outbound" ? (quoted.authorName ?? t("you")) : t("contact")}
      </p>
      <p className="line-clamp-2 italic opacity-80">
        {quoted.revoked ? t("deleted") : (quoted.preview ?? "…")}
      </p>
    </div>
  );
}

function memberName(members: OrgMember[], userId: unknown): string {
  const m = members.find((x) => x.userId === userId);
  return m?.name ?? "—";
}

function sectorName(sectors: TeamWithMembers[], teamId: unknown): string {
  const t = sectors.find((x) => x.id === teamId);
  return t?.name ?? "—";
}

function SystemLine({
  msg,
  members,
  sectors,
  t,
}: {
  msg: MessageWithAuthorRow;
  members: OrgMember[];
  sectors: TeamWithMembers[];
  t: T;
}) {
  const meta = msg.metadata as Record<string, unknown>;
  let text = t("systemEvent");
  if (meta.system === "transfer") {
    const to = meta.toAssigneeId
      ? memberName(members, meta.toAssigneeId)
      : sectorName(sectors, meta.toSectorId);
    const from = meta.fromAssigneeId ? memberName(members, meta.fromAssigneeId) : t("queue");
    text = t("transfer", { from, to });
  }
  return (
    <li className="text-ink-muted py-1 text-center text-xs italic" data-testid="system-event">
      — {text} · <LocalDateTime date={msg.createdAt} timeStyle="medium" /> —
    </li>
  );
}

function PrivateNote({ msg, t }: { msg: MessageWithAuthorRow; t: T }) {
  return (
    <li
      className="border-warning/40 bg-warning/10 rounded-md border px-3 py-2"
      data-testid="internal-note"
    >
      <p className="text-warning text-xs font-medium">
        {t.rich("internalNote", {
          author: msg.authorName ?? "—",
          date: () => <LocalDateTime date={msg.createdAt} timeStyle="medium" />,
        })}
      </p>
      <p className="mt-1 text-sm whitespace-pre-wrap">{messageText(msg.content, t)}</p>
    </li>
  );
}

function BubbleBody({
  msg,
  canInspect,
  t,
  tc,
}: {
  msg: MessageWithAuthorRow;
  canInspect: boolean;
  t: T;
  tc: T;
}) {
  const content = msg.content as MessageContent;
  if (msg.revokedAt !== null) {
    return (
      <p className="text-sm italic opacity-70" data-testid="revoked-placeholder">
        🚫 {t("deleted")}
        {canInspect && <RevokedActions conversationId={msg.conversationId} messageId={msg.id} />}
      </p>
    );
  }
  if (content.type === "media") return <MediaContent msg={msg} t={t} tc={tc} />;
  return <p className="text-sm whitespace-pre-wrap">{messageText(content, t)}</p>;
}

function BubbleMeta({
  msg,
  outbound,
  isChannelMessage,
  canInspect,
  menu,
  t,
}: {
  msg: MessageWithAuthorRow;
  outbound: boolean;
  isChannelMessage: boolean;
  canInspect: boolean;
  menu: React.ReactNode;
  t: T;
}) {
  return (
    <p
      className={cn(
        "mt-1 flex items-center justify-end gap-1 text-xs",
        outbound ? "text-ink-on-signal/70" : "text-ink-muted",
      )}
    >
      {outbound && msg.authorName ? `${msg.authorName} · ` : ""}
      <LocalDateTime date={msg.sentAt ?? msg.createdAt} timeStyle="medium" />
      {msg.editedAt && (
        <>
          {" · "}
          <EditedIndicator
            conversationId={msg.conversationId}
            messageId={msg.id}
            canInspect={canInspect}
          />
        </>
      )}
      {msg.status === "failed" && (
        <span className="text-danger">
          {" "}
          · {t("failed")} · <ResendButton conversationId={msg.conversationId} messageId={msg.id} />
        </span>
      )}
      {outbound && isChannelMessage && <MessageTicks status={msg.status} t={t} />}
      {menu}
    </p>
  );
}

/** Per-message affordances — the ~15min edit window is enforced server-side. */
function messageAccess(args: {
  msg: MessageWithAuthorRow;
  currentUserId: string;
  canInteract: boolean;
  t: T;
}) {
  const { msg, currentUserId, canInteract, t } = args;
  const content = msg.content as MessageContent;
  const isChannelMessage = msg.externalId !== null;
  const available = canInteract && isChannelMessage && msg.revokedAt === null;
  const ownOutbound = available && msg.direction === "outbound" && msg.authorId === currentUserId;
  const currentText = messageText(content, t);
  return {
    isChannelMessage,
    access: {
      currentText,
      canReact: available,
      canEdit: ownOutbound && content.type === "text",
      canDelete: ownOutbound,
      replyTarget:
        available && msg.externalId
          ? { externalId: msg.externalId, preview: currentText }
          : undefined,
    },
  };
}

type MessageItemProps = {
  msg: MessageWithAuthorRow;
  members: OrgMember[];
  sectors: TeamWithMembers[];
  currentUserId: string;
  canInspect: boolean;
  canInteract: boolean;
};

export async function MessageItem(props: MessageItemProps) {
  const { msg, members, sectors, currentUserId, canInspect, canInteract } = props;
  const t = await getTranslations("message");
  const tc = await getTranslations("common");
  if ((msg.metadata as Record<string, unknown>).system) {
    return <SystemLine msg={msg} members={members} sectors={sectors} t={t} />;
  }
  if (msg.private) return <PrivateNote msg={msg} t={t} />;

  const outbound = msg.direction === "outbound";
  const { isChannelMessage, access } = messageAccess({ msg, currentUserId, canInteract, t });
  const target = { conversationId: msg.conversationId, messageId: msg.id };

  return (
    <li className={cn("group flex", outbound ? "justify-end" : "justify-start")}>
      <MessageContextMenu {...target} {...access}>
        <div className="max-w-4/5">
          <div
            id={`msg-${msg.id}`}
            className={cn(
              "target:ring-line-accent relative scroll-mt-32 rounded-lg px-3 py-2 target:ring-2",
              outbound ? "bg-signal text-ink-on-signal" : "bg-raised",
            )}
          >
            {msg.quoted && <QuoteBlock quoted={msg.quoted} outbound={outbound} t={t} />}
            <BubbleBody msg={msg} canInspect={canInspect} t={t} tc={tc} />
            <BubbleMeta
              msg={msg}
              outbound={outbound}
              isChannelMessage={isChannelMessage}
              canInspect={canInspect}
              t={t}
              menu={<MessageMenu {...target} {...access} />}
            />
          </div>
          <ReactionChips
            conversationId={msg.conversationId}
            messageId={msg.id}
            reactions={msg.reactions}
            currentUserId={currentUserId}
            interactive={canInteract}
          />
        </div>
      </MessageContextMenu>
    </li>
  );
}
