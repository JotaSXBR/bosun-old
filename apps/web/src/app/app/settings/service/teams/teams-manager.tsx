"use client";

import type { OrgMember } from "@crm/core/organizations";
import type { TeamWithMembers } from "@crm/core/teams";
import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import { Input } from "@crm/design-system/components/input";
import { Select } from "@crm/design-system/components/select";
import { toast } from "@crm/design-system/components/toast";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { CSSProperties } from "react";
import { useState, useTransition } from "react";

import type { TeamsActionResult } from "@/server/actions/teams";
import {
  addTeamMemberAction,
  createTeamAction,
  deleteTeamAction,
  removeTeamMemberAction,
  updateTeamAction,
} from "@/server/actions/teams";

type Run = (action: Promise<TeamsActionResult>, success?: string, onSuccess?: () => void) => void;

export function TeamsManager({
  teams,
  members,
  canManage,
}: {
  teams: TeamWithMembers[];
  members: OrgMember[];
  canManage: boolean;
}) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  // eslint-disable-next-line no-restricted-syntax -- persisted team color default (hex data, not styling)
  const [color, setColor] = useState("#3366ff");

  const run: Run = (action, success, onSuccess) =>
    startTransition(async () => {
      const result = await action;
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (success) toast.success(success);
      onSuccess?.();
      router.refresh();
    });

  const submitNew = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    run(createTeamAction({ name: trimmed, color }), t("teamsManager.created"), () => setName(""));
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <Card title={t("teamsManager.newTeam")} subtitle={t("teamsManager.newTeamDescription")}>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <label htmlFor="new-team-name" className="text-sm font-medium">
                {t("teamsManager.name")}
              </label>
              <Input
                shape="rounded"
                id="new-team-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("teamsManager.namePlaceholder")}
                maxLength={100}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="new-team-color" className="text-sm font-medium">
                {t("teamsManager.color")}
              </label>
              <input
                id="new-team-color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="border-line block h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
              />
            </div>
            <Button variant="primary" disabled={pending || !name.trim()} onClick={submitNew}>
              {t("teamsManager.create")}
            </Button>
          </div>
        </Card>
      )}

      <Card title={t("teamsManager.list")}>
        {teams.length === 0 ? (
          <p className="text-ink-muted text-sm">{t("teamsManager.empty")}</p>
        ) : (
          <ul className="space-y-4" data-testid="team-list">
            {teams.map((team) => (
              <TeamRow
                key={team.id}
                team={team}
                members={members}
                canManage={canManage}
                pending={pending}
                run={run}
                t={t}
                tc={tc}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

type T = ReturnType<typeof useTranslations>;

function TeamRow({
  team,
  members,
  canManage,
  pending,
  run,
  t,
  tc,
}: {
  team: TeamWithMembers;
  members: OrgMember[];
  canManage: boolean;
  pending: boolean;
  run: Run;
  t: T;
  tc: T;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(team.name);
  // eslint-disable-next-line no-restricted-syntax -- persisted team color default (hex data, not styling)
  const [editColor, setEditColor] = useState(team.color ?? "#3366ff");

  const saveEdit = () => {
    const trimmed = editName.trim();
    if (!trimmed) return;
    run(
      updateTeamAction({ teamId: team.id, name: trimmed, color: editColor }),
      t("teamsManager.saved"),
      () => setEditing(false),
    );
  };

  const remove = () => {
    if (!window.confirm(t("teamsManager.deleteConfirm", { name: team.name }))) {
      return;
    }
    run(deleteTeamAction(team.id), t("teamsManager.deleted"));
  };

  return (
    <li className="space-y-3 border-b pb-4 last:border-0">
      <div className="flex items-center justify-between gap-4">
        {editing ? (
          <div className="flex flex-1 items-center gap-2">
            <input
              type="color"
              value={editColor}
              onChange={(e) => setEditColor(e.target.value)}
              aria-label={t("teamsManager.teamColor")}
              className="border-line block h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
            />
            <Input
              shape="rounded"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              maxLength={100}
              aria-label={t("teamsManager.teamName")}
            />
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span
              className="inline-block h-4 w-4 rounded-full border bg-(color:--team-color)"
              style={{ "--team-color": team.color ?? "transparent" } as CSSProperties}
              aria-hidden
            />
            <span className="font-medium">{team.name}</span>
          </div>
        )}
        {canManage && (
          <div className="flex shrink-0 items-center gap-2">
            {editing ? (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={pending || !editName.trim()}
                  onClick={saveEdit}
                >
                  {tc("save")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => setEditing(false)}
                >
                  {tc("cancel")}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setEditName(team.name);
                  // eslint-disable-next-line no-restricted-syntax -- persisted team color default (hex data, not styling)
                  setEditColor(team.color ?? "#3366ff");
                  setEditing(true);
                }}
              >
                {t("teamsManager.edit")}
              </Button>
            )}
            <Button size="sm" variant="danger" disabled={pending} onClick={remove}>
              {t("teamsManager.delete")}
            </Button>
          </div>
        )}
      </div>

      <TeamMembers
        team={team}
        members={members}
        canManage={canManage}
        pending={pending}
        run={run}
        t={t}
      />
    </li>
  );
}

function TeamMembers({
  team,
  members,
  canManage,
  pending,
  run,
  t,
}: {
  team: TeamWithMembers;
  members: OrgMember[];
  canManage: boolean;
  pending: boolean;
  run: Run;
  t: T;
}) {
  const [newMember, setNewMember] = useState("");
  // Viewers can never work a ticket — no point offering them as members.
  const candidates = members.filter(
    (m) => m.role !== "viewer" && !team.memberUserIds.includes(m.userId),
  );
  const nameOf = (userId: string) =>
    members.find((m) => m.userId === userId)?.name ?? t("teamsManager.removedUser");

  const addMember = () => {
    if (!newMember) return;
    run(addTeamMemberAction({ teamId: team.id, userId: newMember }), undefined, () =>
      setNewMember(""),
    );
  };

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
          <Button
            size="sm"
            variant="secondary"
            disabled={pending || !newMember}
            onClick={addMember}
          >
            {t("teamsManager.add")}
          </Button>
        </div>
      )}
    </div>
  );
}
