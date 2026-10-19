"use client";

import type { OrgMember } from "@crm/core/organizations";
import type { TeamWithMembers } from "@crm/core/teams";
import { Button } from "@crm/design-system/components/button";
import { Input } from "@crm/design-system/components/input";
import { useTranslations } from "next-intl";
import type { CSSProperties } from "react";
import { useState } from "react";

import type { RunAction } from "@/lib/use-run-action";
import { deleteTeamAction, updateTeamAction } from "@/server/actions/teams";

import { TeamMembers } from "./team-members";

// eslint-disable-next-line no-restricted-syntax -- persisted team color default (hex data, not styling)
export const DEFAULT_TEAM_COLOR = "#3366ff";

type RowProps = {
  team: TeamWithMembers;
  members: OrgMember[];
  canManage: boolean;
  pending: boolean;
  run: RunAction;
};

/** Inline edit state of one team row: open flag and its draft name/color. */
function useTeamEdit(team: TeamWithMembers, run: RunAction) {
  const t = useTranslations("settings");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(team.name);
  const [editColor, setEditColor] = useState(team.color ?? DEFAULT_TEAM_COLOR);

  const startEdit = () => {
    setEditName(team.name);
    setEditColor(team.color ?? DEFAULT_TEAM_COLOR);
    setEditing(true);
  };

  const saveEdit = () => {
    const trimmed = editName.trim();
    if (!trimmed) return;
    run(
      updateTeamAction({ teamId: team.id, name: trimmed, color: editColor }),
      t("teamsManager.saved"),
      () => setEditing(false),
    );
  };

  return {
    editing,
    setEditing,
    editName,
    setEditName,
    editColor,
    setEditColor,
    startEdit,
    saveEdit,
  };
}

type Edit = ReturnType<typeof useTeamEdit>;

function TeamTitle({ team, edit }: { team: TeamWithMembers; edit: Edit }) {
  const t = useTranslations("settings");
  if (!edit.editing) {
    return (
      <div className="flex items-center gap-3">
        <span
          className="inline-block h-4 w-4 rounded-full border bg-(color:--team-color)"
          style={{ "--team-color": team.color ?? "transparent" } as CSSProperties}
          aria-hidden
        />
        <span className="font-medium">{team.name}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-1 items-center gap-2">
      <input
        type="color"
        value={edit.editColor}
        onChange={(e) => edit.setEditColor(e.target.value)}
        aria-label={t("teamsManager.teamColor")}
        className="border-line block h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
      />
      <Input
        shape="rounded"
        value={edit.editName}
        onChange={(e) => edit.setEditName(e.target.value)}
        maxLength={100}
        aria-label={t("teamsManager.teamName")}
      />
    </div>
  );
}

function TeamActions({
  team,
  edit,
  pending,
  run,
}: Pick<RowProps, "team" | "pending" | "run"> & { edit: Edit }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");

  const remove = () => {
    if (!window.confirm(t("teamsManager.deleteConfirm", { name: team.name }))) {
      return;
    }
    run(deleteTeamAction(team.id), t("teamsManager.deleted"));
  };

  return (
    <div className="flex shrink-0 items-center gap-2">
      {edit.editing ? (
        <>
          <Button
            variant="primary"
            size="sm"
            disabled={pending || !edit.editName.trim()}
            onClick={edit.saveEdit}
          >
            {tc("save")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => edit.setEditing(false)}
          >
            {tc("cancel")}
          </Button>
        </>
      ) : (
        <Button size="sm" variant="secondary" disabled={pending} onClick={edit.startEdit}>
          {t("teamsManager.edit")}
        </Button>
      )}
      <Button size="sm" variant="danger" disabled={pending} onClick={remove}>
        {t("teamsManager.delete")}
      </Button>
    </div>
  );
}

export function TeamRow({ team, members, canManage, pending, run }: RowProps) {
  const edit = useTeamEdit(team, run);

  return (
    <li className="space-y-3 border-b pb-4 last:border-0">
      <div className="flex items-center justify-between gap-4">
        <TeamTitle team={team} edit={edit} />
        {canManage && <TeamActions team={team} edit={edit} pending={pending} run={run} />}
      </div>

      <TeamMembers
        team={team}
        members={members}
        canManage={canManage}
        pending={pending}
        run={run}
      />
    </li>
  );
}
