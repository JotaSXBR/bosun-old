"use client";

import { Button } from "@crm/design-system/components/button";
import { Input } from "@crm/design-system/components/input";
import { Label } from "@crm/design-system/components/label";
import { Select } from "@crm/design-system/components/select";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { useRunAction } from "@/lib/use-run-action";
import { createLlmCredentialAction } from "@/server/actions/ai";

type Provider = "openai" | "anthropic" | "openrouter";

type Draft = {
  provider: Provider;
  apiKey: string;
  label: string;
  model: string;
  priority: string;
  zdr: boolean;
};

const EMPTY_DRAFT: Draft = {
  provider: "openrouter",
  apiKey: "",
  label: "",
  model: "",
  priority: "0",
  zdr: false,
};

type RowProps = {
  draft: Draft;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  pending: boolean;
};

function ProviderModelLabelRow({ draft, set, pending }: RowProps) {
  const t = useTranslations("settings.ai.credentials");
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="space-y-1">
        <Label htmlFor="cred-provider">{t("provider")}</Label>
        <Select
          options={[
            { value: "openrouter", label: "OpenRouter" },
            { value: "openai", label: "OpenAI" },
            { value: "anthropic", label: "Anthropic" },
          ]}
          value={draft.provider}
          onChange={(v) => set("provider", v as Provider)}
          disabled={pending}
          id="cred-provider"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="cred-model">{t("model")}</Label>
        <Input
          shape="rounded"
          id="cred-model"
          value={draft.model}
          onChange={(e) => set("model", e.target.value)}
          placeholder="openai/gpt-5-mini"
          disabled={pending}
        />
        <p className="text-ink-muted text-xs">{t("modelHint")}</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="cred-label">{t("label")}</Label>
        <Input
          shape="rounded"
          id="cred-label"
          value={draft.label}
          onChange={(e) => set("label", e.target.value)}
          maxLength={100}
          disabled={pending}
        />
      </div>
    </div>
  );
}

function KeyPriorityRow({ draft, set, pending }: RowProps) {
  const t = useTranslations("settings.ai.credentials");
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="cred-key">{t("apiKey")}</Label>
        <Input
          shape="rounded"
          id="cred-key"
          type="password"
          value={draft.apiKey}
          onChange={(e) => set("apiKey", e.target.value)}
          placeholder="sk-..."
          autoComplete="off"
          disabled={pending}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="cred-priority">{t("priority")}</Label>
        <Input
          shape="rounded"
          id="cred-priority"
          type="number"
          min={0}
          max={99}
          value={draft.priority}
          onChange={(e) => set("priority", e.target.value)}
          disabled={pending}
        />
        <p className="text-ink-muted text-xs">{t("priorityHint")}</p>
      </div>
    </div>
  );
}

/** Inline create form — the API key is write-only and never re-rendered. */
export function CredentialCreateForm() {
  const t = useTranslations("settings.ai.credentials");
  const { pending, run } = useRunAction();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const set: RowProps["set"] = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = () =>
    run(
      createLlmCredentialAction({
        provider: draft.provider,
        apiKey: draft.apiKey,
        label: draft.label.trim() || undefined,
        model: draft.model.trim(),
        priority: Number(draft.priority) || 0,
        zdr: draft.zdr,
      }),
      t("created"),
      () => setDraft((d) => ({ ...d, apiKey: "", label: "", model: "" })),
    );

  return (
    <div className="space-y-3 border-t pt-4" data-testid="credential-form">
      <p className="text-sm font-medium">{t("new")}</p>
      <ProviderModelLabelRow draft={draft} set={set} pending={pending} />
      <KeyPriorityRow draft={draft} set={set} pending={pending} />
      <div className="flex items-center gap-2">
        <input
          id="cred-zdr"
          type="checkbox"
          checked={draft.zdr}
          onChange={(e) => set("zdr", e.target.checked)}
          disabled={pending}
          className="border-line size-4 rounded-xs border"
        />
        <Label htmlFor="cred-zdr" className="text-sm font-normal">
          {t("zdr")} — {t("zdrHint")}
        </Label>
      </div>
      <Button
        variant="primary"
        disabled={pending || !draft.apiKey.trim() || !draft.model.trim()}
        onClick={submit}
      >
        {t("create")}
      </Button>
    </div>
  );
}
