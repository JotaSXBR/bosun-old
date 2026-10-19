"use client";

import type { ConversationDetailRow } from "@crm/core/messaging";
import type { OrgMember } from "@crm/core/organizations";
import type { TeamWithMembers } from "@crm/core/teams";
import { Button } from "@crm/design-system/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@crm/design-system/components/dropdown-menu";
import { useFormatter, type useTranslations } from "next-intl";
import { useState } from "react";

import type { RunAction } from "@/lib/use-run-action";
import { snoozeConversationAction, transferConversationAction } from "@/server/actions/messaging";

export type T = ReturnType<typeof useTranslations>;

const SNOOZE_PRESET_KEY = {
  "1h": "snooze1h",
  tomorrow: "snoozeTomorrow",
  week: "snoozeWeek",
} as const;

export function snoozeTarget(preset: keyof typeof SNOOZE_PRESET_KEY): Date {
  const now = new Date();
  if (preset === "1h") return new Date(now.getTime() + 3_600_000);
  if (preset === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }
  return new Date(now.getTime() + 7 * 86_400_000);
}

function SnoozeSubmenu({
  conversationId,
  run,
  t,
}: {
  conversationId: string;
  run: RunAction;
  t: T;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{t("snooze")}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {(Object.keys(SNOOZE_PRESET_KEY) as (keyof typeof SNOOZE_PRESET_KEY)[]).map((p) => (
          <DropdownMenuItem
            key={p}
            onSelect={() =>
              run(snoozeConversationAction({ conversationId, until: snoozeTarget(p) }))
            }
          >
            {t(SNOOZE_PRESET_KEY[p])}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function TransferSubmenu({
  conversationId,
  agents,
  sectors,
  run,
  t,
}: {
  conversationId: string;
  agents: OrgMember[];
  sectors: TeamWithMembers[];
  run: RunAction;
  t: T;
}) {
  const transfer = (target: string) => {
    const [kind, id] = target.split(":");
    run(
      transferConversationAction(
        kind === "user" ? { conversationId, assigneeId: id! } : { conversationId, sectorId: id! },
      ),
    );
  };

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{t("transferTo")}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuLabel>{t("agents")}</DropdownMenuLabel>
        {agents.map((m) => (
          <DropdownMenuItem key={m.userId} onSelect={() => transfer(`user:${m.userId}`)}>
            {m.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuLabel>{t("sectors")}</DropdownMenuLabel>
        {sectors.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => transfer(`sector:${s.id}`)}>
            {s.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ResumeItem({ conversationId, run, t }: { conversationId: string; run: RunAction; t: T }) {
  return (
    <>
      <DropdownMenuItem
        onSelect={() => run(snoozeConversationAction({ conversationId, until: null }))}
      >
        {t("resume")}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

function SnoozedNote({ until, t }: { until: Date; t: T }) {
  const format = useFormatter();
  return (
    <span className="text-ink-muted text-sm">
      {t("snoozedUntil", {
        date: format.dateTime(until, { dateStyle: "short", timeStyle: "short" }),
      })}
    </span>
  );
}

/** Less-frequent actions live under one ghost trigger — never competes with
 * the primary. */
export function MoreActions({
  conversation,
  agents,
  sectors,
  pending,
  run,
  t,
}: {
  conversation: ConversationDetailRow;
  agents: OrgMember[];
  sectors: TeamWithMembers[];
  pending: boolean;
  run: RunAction;
  t: T;
}) {
  const [mountedAt] = useState(() => Date.now());
  const conversationId = conversation.id;
  const snoozedUntil = conversation.snoozedUntil ? new Date(conversation.snoozedUntil) : null;
  const snoozed = snoozedUntil !== null && snoozedUntil.getTime() > mountedAt;

  return (
    <>
      {snoozed && <SnoozedNote until={snoozedUntil} t={t} />}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" iconRight="chevron-down" disabled={pending}>
            {t("moreActions")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {snoozed && <ResumeItem conversationId={conversationId} run={run} t={t} />}
          <SnoozeSubmenu conversationId={conversationId} run={run} t={t} />
          <DropdownMenuSeparator />
          <TransferSubmenu
            conversationId={conversationId}
            agents={agents}
            sectors={sectors}
            run={run}
            t={t}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
