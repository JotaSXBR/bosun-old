"use client";

import { Button } from "@crm/design-system/components/button";
import { Input } from "@crm/design-system/components/input";
import { toast } from "@crm/design-system/components/toast";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { updateWidgetConfigAction } from "@/server/actions/integrations";

import { CopyButton } from "./copy-button";

type WidgetConfigShape = {
  welcomeText?: string;
  accentColor?: string;
  position?: "left" | "right";
};

function PositionField({
  value,
  onChange,
}: {
  value: "left" | "right";
  onChange: (v: "left" | "right") => void;
}) {
  const t = useTranslations("integrations");
  return (
    <label className="space-y-1 text-sm">
      <span className="text-ink-muted text-xs">{t("widget.position")}</span>
      <select
        className="border-line shadow-control h-9 w-full rounded-md border bg-transparent px-3 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value as "left" | "right")}
      >
        <option value="right">{t("widget.right")}</option>
        <option value="left">{t("widget.left")}</option>
      </select>
    </label>
  );
}

type ConfigFormProps = { connectionId: string; config: WidgetConfigShape };

function WidgetConfigForm({ connectionId, config }: ConfigFormProps) {
  const t = useTranslations("integrations");
  const [pending, startTransition] = useTransition();
  const [welcomeText, setWelcomeText] = useState(config.welcomeText ?? "");
  const [accentColor, setAccentColor] = useState(config.accentColor ?? "");
  const [position, setPosition] = useState<"left" | "right">(config.position ?? "right");

  function save() {
    startTransition(async () => {
      const result = await updateWidgetConfigAction(connectionId, {
        welcomeText: welcomeText || undefined,
        accentColor: accentColor || undefined,
        position,
      });
      if (result.ok) toast.success(t("widget.saved"));
      else toast.error(result.error);
    });
  }

  return (
    <div className="grid gap-3 sm:grid-cols-5 sm:items-end">
      <label className="space-y-1 text-sm sm:col-span-2">
        <span className="text-ink-muted text-xs">{t("widget.welcome")}</span>
        <Input
          shape="rounded"
          value={welcomeText}
          onChange={(e) => setWelcomeText(e.target.value)}
          placeholder={t("widget.welcomePlaceholder")}
          maxLength={200}
        />
      </label>
      <label className="space-y-1 text-sm">
        <span className="text-ink-muted text-xs">{t("widget.accentColor")}</span>
        <Input
          shape="rounded"
          value={accentColor}
          onChange={(e) => setAccentColor(e.target.value)}
          // eslint-disable-next-line no-restricted-syntax -- hex-format placeholder for the persisted widget accent color
          placeholder="#ff6600"
          maxLength={32}
        />
      </label>
      <PositionField value={position} onChange={setPosition} />
      <Button variant="primary" type="button" size="sm" disabled={pending} onClick={save}>
        {t("widget.save")}
      </Button>
    </div>
  );
}

/** site_chat connection extras: embed snippet + widget config + demo link. */
export function WidgetPanel({
  connectionId,
  webhookToken,
  origin,
  config,
  canManage,
}: {
  connectionId: string;
  webhookToken: string;
  origin: string;
  config: WidgetConfigShape;
  canManage: boolean;
}) {
  const t = useTranslations("integrations");
  const snippet = `<script src="${origin}/widget.js" data-bosun-widget data-token="${webhookToken}" async></script>`;

  return (
    <div className="space-y-3" data-testid="widget-panel">
      <div className="flex items-center gap-2">
        <code className="bg-raised flex-1 truncate rounded-xs px-2 py-1 text-xs">{snippet}</code>
        <CopyButton value={snippet} />
      </div>
      <div className="text-ink-muted flex items-center gap-3 text-xs">
        <Link href={`/widget-demo?token=${webhookToken}`} className="underline" target="_blank">
          {t("widget.demoLink")}
        </Link>
      </div>
      {canManage && <WidgetConfigForm connectionId={connectionId} config={config} />}
    </div>
  );
}
