"use client";

import type { ConversationDetailRow } from "@crm/core/messaging";
import type { OrgMember } from "@crm/core/organizations";
import type { TeamWithMembers } from "@crm/core/teams";
import { Button } from "@crm/design-system/components/button";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { MoreActions, snoozeTarget, type T } from "@/components/ticket-more-actions";
import { type RunAction, useRunAction } from "@/lib/use-run-action";
import {
  pickupConversationAction,
  reopenTicketAction,
  resolveConversationAction,
  resumeTicketAction,
  setConversationInProgressAction,
  setConversationWaitingAction,
  snoozeConversationAction,
} from "@/server/actions/messaging";

/** Which shortcut keys currently do something — mirrors the visible buttons. */
function actionAvailability(args: {
  conversation: ConversationDetailRow;
  ownsTicket: boolean;
  canWork: boolean;
  isResolved: boolean;
  isClosed: boolean;
}) {
  const { conversation, ownsTicket, canWork, isResolved, isClosed } = args;
  const workable = canWork && ownsTicket && !isResolved && !isClosed;
  const pickup = workable && conversation.status === "open" && conversation.assigneeId === null;
  return { pickup, resolve: workable && !pickup, snooze: workable };
}

/** A assumir · R resolver · S adiar até amanhã — same guards as the list nav. */
function useTicketShortcuts(args: {
  conversationId: string;
  pickup: boolean;
  resolve: boolean;
  snooze: boolean;
  run: RunAction;
}) {
  const { conversationId, pickup, resolve, snooze, run } = args;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "a" && pickup) run(pickupConversationAction({ conversationId }));
      else if (key === "r" && resolve) run(resolveConversationAction({ conversationId }));
      else if (key === "s" && snooze) {
        run(snoozeConversationAction({ conversationId, until: snoozeTarget("tomorrow") }));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
}

type TicketActionsProps = {
  conversation: ConversationDetailRow;
  userId: string;
  members: OrgMember[];
  sectors: TeamWithMembers[];
  canWork: boolean;
  isResolved: boolean;
  isClosed: boolean;
  isViewer: boolean;
};

/** Shortcut hint line under the buttons — only the keys that currently do something. */
function ShortcutHints({
  keys,
  t,
}: {
  keys: { pickup: boolean; resolve: boolean; snooze: boolean };
  t: T;
}) {
  if (!keys.pickup && !keys.resolve && !keys.snooze) return null;
  return (
    <p className="text-ink-subtle mt-2 text-xs" data-testid="action-shortcuts">
      {[
        keys.pickup && t("shortcutPickup"),
        keys.resolve && t("shortcutResolve"),
        keys.snooze && t("shortcutSnooze"),
      ]
        .filter(Boolean)
        .join(" · ")}
    </p>
  );
}

/** Reopen / new-service buttons for finished tickets. */
function RestartButtons(props: {
  conversationId: string;
  isResolved: boolean;
  isClosed: boolean;
  pending: boolean;
  run: RunAction;
  t: T;
}) {
  const { conversationId, isResolved, isClosed, pending, run, t } = props;
  return (
    <>
      {isResolved && (
        <Button
          variant="primary"
          disabled={pending}
          onClick={() => run(reopenTicketAction({ conversationId }))}
        >
          {t("reopen")}
        </Button>
      )}
      {isClosed && (
        <Button
          variant="primary"
          disabled={pending}
          onClick={() => run(resumeTicketAction({ conversationId }))}
        >
          {t("newService")}
        </Button>
      )}
    </>
  );
}

export function TicketActions(props: TicketActionsProps) {
  const { conversation, userId, members, sectors, canWork, isResolved, isClosed } = props;
  const t = useTranslations("tickets");
  const { pending, run } = useRunAction();
  // Work actions belong to the assignee; another agent's path is Transfer.
  const ownsTicket = conversation.assigneeId === null || conversation.assigneeId === userId;
  const keys = actionAvailability({ conversation, ownsTicket, canWork, isResolved, isClosed });
  useTicketShortcuts({ conversationId: conversation.id, ...keys, run });

  if (props.isViewer) return null;

  return (
    <div className="border-t pt-4" data-testid="ticket-actions">
      <div className="flex flex-wrap items-center gap-2">
        <RestartButtons
          conversationId={conversation.id}
          isResolved={isResolved}
          isClosed={isClosed}
          pending={pending}
          run={run}
          t={t}
        />
        {canWork && !ownsTicket && (
          <span className="text-ink-muted text-sm">
            {t("inServiceBy", { name: conversation.assigneeName ?? "?" })}
          </span>
        )}
        {canWork && ownsTicket && !isResolved && !isClosed && (
          <WorkActions conversation={conversation} pending={pending} run={run} t={t} />
        )}
        {canWork && (
          <MoreActions
            conversation={conversation}
            // Viewers can never work a ticket — no point offering them as targets.
            agents={members.filter((m) => m.role !== "viewer")}
            sectors={sectors}
            pending={pending}
            run={run}
            t={t}
          />
        )}
      </div>
      <ShortcutHints keys={keys} t={t} />
    </div>
  );
}

/** Uniform secondary status toggle: in progress ⇄ waiting for the customer. */
function StatusToggle({
  conversation,
  pending,
  run,
  t,
}: {
  conversation: ConversationDetailRow;
  pending: boolean;
  run: RunAction;
  t: T;
}) {
  const conversationId = conversation.id;
  if (conversation.status === "in_progress") {
    return (
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() => run(setConversationWaitingAction({ conversationId }))}
      >
        {t("waiting")}
      </Button>
    );
  }
  if (conversation.status === "waiting_customer") {
    return (
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() => run(setConversationInProgressAction({ conversationId }))}
      >
        {t("inProgress")}
      </Button>
    );
  }
  return null;
}

/** Primary contextual action + uniform secondary status toggle. */
function WorkActions({
  conversation,
  pending,
  run,
  t,
}: {
  conversation: ConversationDetailRow;
  pending: boolean;
  run: RunAction;
  t: T;
}) {
  const conversationId = conversation.id;
  const unassigned = conversation.assigneeId === null;
  return (
    <>
      {conversation.status === "open" && unassigned ? (
        <Button
          variant="primary"
          disabled={pending}
          onClick={() => run(pickupConversationAction({ conversationId }))}
        >
          {t("pickup")}
        </Button>
      ) : (
        <Button
          variant="primary"
          disabled={pending}
          onClick={() => run(resolveConversationAction({ conversationId }))}
        >
          {t("resolve")}
        </Button>
      )}
      <StatusToggle conversation={conversation} pending={pending} run={run} t={t} />
    </>
  );
}
