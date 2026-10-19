"use client";

import type { OrgMember } from "@crm/core/organizations";
import type { TeamWithMembers } from "@crm/core/teams";
import { Button } from "@crm/design-system/components/button";
import { Select } from "@crm/design-system/components/select";
import { useTranslations } from "next-intl";
import { useState } from "react";

import type { RunAction } from "@/lib/use-run-action";
import { addTeamMemberAction, removeTeamMemberAction } from "@/server/actions/teams";

type MembersProps = {
  team: TeamWithMembers;
  members: OrgMember[];
  canManage: boolean;
  pending: boolean;
  run: RunAction;
};

function AddMember({
  team,
  candidates,
  pending,
  run,
}: Pick<MembersProps, "team" | "pending" | "run"> & { candidates: OrgMember[] }) {
  const t = useTranslations("settings");
  const [newMember, setNewMember] = useState("");

  const addMember = () => {
    if (!newMember) return;
    run(addTeamMemberAction({ teamId: team.id, userId: newMember }), undefined, () =>
      setNewMember(""),
    );
  };

  return (
    <div className="flex items-center gap-1">
      <Select
        options={candidates.map((m) => ({ value: m.userId, label: m.name }))}
        value={newMember || undefined}
        onChange={setNewMember}
        placeholder={t("teamsManager.addMemberPlaceholder")}
        aria-label={t("teamsManager.addMemberTo", { team: team.name })}
        disabled={pending}
        size="sm"
        className="w-44"
      />
      <Button size="sm" variant="secondary" disabled={pending || !newMember} onClick={addMember}>
        {t("teamsManager.add")}
      </Button>
    </div>
  );
}

export function TeamMembers({ team, members, canManage, pending, run }: MembersProps) {
  const t = useTranslations("settings");
  // Viewers can never work a ticket — no point offering them as members.
  const candidates = members.filter(
    (m) => m.role !== "viewer" && !team.memberUserIds.includes(m.userId),
  );
  const nameOf = (userId: string) =>
    members.find((m) => m.userId === userId)?.name ?? t("teamsManager.removedUser");

  return (
    <div className="flex flex-wrap items-center gap-2">
      {team.memberUserIds.length === 0 && (
        <span className="text-ink-muted text-sm">{t("teamsManager.noMembers")}</span>
      )}
      {team.memberUserIds.map((userId) => (
        <span
          key={userId}
          className="bg-raised inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
        >
          {nameOf(userId)}
          {canManage && (
            <button
              type="button"
              aria-label={t("teamsManager.removeMember", { name: nameOf(userId) })}
              className="hover:text-danger"
              disabled={pending}
              onClick={() => run(removeTeamMemberAction({ teamId: team.id, userId }))}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {canManage && candidates.length > 0 && (
        <AddMember team={team} candidates={candidates} pending={pending} run={run} />
      )}
    </div>
  );
}
