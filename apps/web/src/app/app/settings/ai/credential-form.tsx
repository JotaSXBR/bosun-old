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

/** Inline create form — the API key is write-only and never re-rendered. */
export function CredentialCreateForm() {
  const t = useTranslations("settings.ai.credentials");
  const { pending, run } = useRunAction();
  const [provider, setProvider] = useState<Provider>("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("");
  const [priority, setPriority] = useState("0");
  const [zdr, setZdr] = useState(false);

  const submit = () =>
    run(
      createLlmCredentialAction({
        provider,
        apiKey,
        label: label.trim() || undefined,
        model: model.trim(),
        priority: Number(priority) || 0,
        zdr,
      }),
      t("created"),
      () => {
        setApiKey("");
        setLabel("");
        setModel("");
      },
    );

  return (
    <div className="space-y-3 border-t pt-4" data-testid="credential-form">
      <p className="text-sm font-medium">{t("new")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="cred-provider">{t("provider")}</Label>
          <Select
            options={[
              { value: "openrouter", label: "OpenRouter" },
              { value: "openai", label: "OpenAI" },
              { value: "anthropic", label: "Anthropic" },
            ]}
            value={provider}
            onChange={(v) => setProvider(v as Provider)}
            disabled={pending}
            id="cred-provider"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cred-model">{t("model")}</Label>
          <Input
            shape="rounded"
            id="cred-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
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
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={100}
            disabled={pending}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="cred-key">{t("apiKey")}</Label>
          <Input
            shape="rounded"
            id="cred-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
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
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            disabled={pending}
          />
          <p className="text-ink-muted text-xs">{t("priorityHint")}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          id="cred-zdr"
          type="checkbox"
          checked={zdr}
          onChange={(e) => setZdr(e.target.checked)}
          disabled={pending}
          className="border-line size-4 rounded-xs border"
        />
        <Label htmlFor="cred-zdr" className="text-sm font-normal">
          {t("zdr")} — {t("zdrHint")}
        </Label>
      </div>
      <Button
        variant="primary"
        disabled={pending || !apiKey.trim() || !model.trim()}
        onClick={submit}
      >
        {t("create")}
      </Button>
    </div>
  );
}
