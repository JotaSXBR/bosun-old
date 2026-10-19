"use client";

import type { OrgMember } from "@crm/core/organizations";
import type { TeamWithMembers } from "@crm/core/teams";
import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import { Input } from "@crm/design-system/components/input";
import { useTranslations } from "next-intl";
import { useState } from "react";

import type { RunAction } from "@/lib/use-run-action";
import { useRunAction } from "@/lib/use-run-action";
import { createTeamAction } from "@/server/actions/teams";

import { DEFAULT_TEAM_COLOR, TeamRow } from "./team-row";

function NewTeamCard({ pending, run }: { pending: boolean; run: RunAction }) {
  const t = useTranslations("settings");
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_TEAM_COLOR);

  const submitNew = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    run(createTeamAction({ name: trimmed, color }), t("teamsManager.created"), () => setName(""));
  };

  return (
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
  );
}

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
  const { pending, run } = useRunAction();

  return (
    <div className="space-y-4">
      {canManage && <NewTeamCard pending={pending} run={run} />}

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
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
