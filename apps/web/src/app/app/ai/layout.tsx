import { Card } from "@crm/design-system/components/card";
import { PageHeader } from "@crm/design-system/templates/page-header";
import { hasPermission } from "@crm/permissions";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import {
  getOrgSettings,
  listOrgLlmCredentials,
  listOrgStaleBrainEntries,
  listOrgSuggestions,
} from "@/server/services";
import { requireTenantContext } from "@/server/tenant";

import { AiModuleTabs } from "./ai-module-tabs";

const OBSERVER_MODE_KEYS = {
  off: "modeOff",
  on_close: "modeOnClose",
  interval: "modeInterval",
  realtime: "modeRealtime",
} as const;

export default async function AiModuleLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations("ai");
  const to = await getTranslations("settings.ai.observer");
  const format = await getFormatter();
  const ctx = await requireTenantContext();
  if (!hasPermission(ctx.role, { ai: ["read"] })) notFound();

  const [settings, credentials, suggestions, stale] = await Promise.all([
    getOrgSettings(ctx),
    listOrgLlmCredentials(ctx),
    listOrgSuggestions(ctx),
    listOrgStaleBrainEntries(ctx),
  ]);
  const pending = suggestions.filter((s) => s.status === "pending").length;
  const credential = credentials[0];
  const modeKey =
    (OBSERVER_MODE_KEYS as Record<string, string | undefined>)[settings.aiObserverMode] ??
    "modeOff";

  return (
    <main className="p-page-pad mx-auto max-w-3xl space-y-6">
      <PageHeader title={t("title")} />
      <Card className="text-sm">
        {credential ? (
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>
              <span className="text-ink-muted">{t("resumo.credential")} </span>
              {credential.label ?? credential.provider}
            </span>
            <span>
              <span className="text-ink-muted">{t("resumo.observerMode")} </span>
              {to(modeKey)}
            </span>
            <span>
              <span className="text-ink-muted">{t("resumo.lastAnalysis")} </span>
              {settings.observerLastScanAt
                ? format.dateTime(settings.observerLastScanAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : "—"}
            </span>
            <span>
              <span className="text-ink-muted">{t("resumo.pending")} </span>
              {t("resumo.pendingCounts", { reviews: pending, stale: stale.length })}
            </span>
          </div>
        ) : (
          <p className="text-ink-muted">
            {t("resumo.noKey")}{" "}
            <Link href="/app/settings/ai/credentials" className="text-ink underline">
              {t("resumo.noKeyLink")}
            </Link>
          </p>
        )}
      </Card>
      <AiModuleTabs />
      {children}
    </main>
  );
}
