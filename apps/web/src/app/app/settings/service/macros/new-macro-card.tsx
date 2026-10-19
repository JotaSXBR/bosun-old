"use client";

import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import { Input } from "@crm/design-system/components/input";
import { Textarea } from "@crm/design-system/components/textarea";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useState } from "react";

import type { RunAction } from "@/lib/use-run-action";
import { createMacroAction, proposeMacroAction } from "@/server/actions/macros";

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

/** Draft fields + submit: create directly (writers) or propose with a rationale (the rest). */
function useNewMacro(canWrite: boolean, run: RunAction) {
  const t = useTranslations("settings.macros");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [rationale, setRationale] = useState("");

  const submit = () => {
    const trimmedName = name.trim().replace(/^\/+/, "");
    const trimmedContent = content.trim();
    if (!trimmedName || !trimmedContent) return;
    if (canWrite) {
      run(createMacroAction({ name: trimmedName, content: trimmedContent }), t("created"), () => {
        setName("");
        setContent("");
      });
    } else {
      const trimmedRationale = rationale.trim();
      if (!trimmedRationale) return;
      run(
        proposeMacroAction({
          name: trimmedName,
          content: trimmedContent,
          rationale: trimmedRationale,
        }),
        t("proposed"),
        () => {
          setName("");
          setContent("");
          setRationale("");
        },
      );
    }
  };

  return { name, setName, content, setContent, rationale, setRationale, submit };
}

export function NewMacroCard({
  canWrite,
  isPending,
  run,
}: {
  canWrite: boolean;
  isPending: boolean;
  run: RunAction;
}) {
  const t = useTranslations("settings.macros");
  const draft = useNewMacro(canWrite, run);

  return (
    <Card title={canWrite ? t("newTitle") : t("proposeTitle")} subtitle={t("newSubtitle")}>
      <div className="space-y-3">
        <Field id="macro-name" label={t("name")}>
          <Input
            id="macro-name"
            shape="rounded"
            value={draft.name}
            placeholder={t("namePlaceholder")}
            onChange={(e) => draft.setName(e.target.value)}
          />
        </Field>
        <Field id="macro-content" label={t("content")}>
          <Textarea
            id="macro-content"
            rows={3}
            value={draft.content}
            placeholder={t("contentPlaceholder")}
            onChange={(e) => draft.setContent(e.target.value)}
          />
        </Field>
        {!canWrite && (
          <Field id="macro-rationale" label={t("rationale")}>
            <Input
              id="macro-rationale"
              shape="rounded"
              value={draft.rationale}
              placeholder={t("rationalePlaceholder")}
              onChange={(e) => draft.setRationale(e.target.value)}
            />
          </Field>
        )}
        <Button variant="primary" size="sm" disabled={isPending} onClick={draft.submit}>
          {canWrite ? t("create") : t("propose")}
        </Button>
      </div>
    </Card>
  );
}
