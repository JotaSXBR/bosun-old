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

const observerModeKey = (mode: string): string =>
  (OBSERVER_MODE_KEYS as Record<string, string | undefined>)[mode] ?? "modeOff";

type Settings = Awaited<ReturnType<typeof getOrgSettings>>;
type Credential = Awaited<ReturnType<typeof listOrgLlmCredentials>>[number];

async function AiSummary({
  settings,
  credential,
  counts,
}: {
  settings: Settings;
  credential: Credential | undefined;
  counts: { reviews: number; stale: number };
}) {
  const t = await getTranslations("ai");
  const to = await getTranslations("settings.ai.observer");
  const format = await getFormatter();
  if (!credential) {
    return (
      <p className="text-ink-muted">
        {t("resumo.noKey")}{" "}
        <Link href="/app/settings/ai/credentials" className="text-ink underline">
          {t("resumo.noKeyLink")}
        </Link>
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1">
      <span>
        <span className="text-ink-muted">{t("resumo.credential")} </span>
        {credential.label ?? credential.provider}
      </span>
      <span>
        <span className="text-ink-muted">{t("resumo.observerMode")} </span>
        {to(observerModeKey(settings.aiObserverMode))}
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
        {t("resumo.pendingCounts", { reviews: counts.reviews, stale: counts.stale })}
      </span>
    </div>
  );
}

export default async function AiModuleLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations("ai");
  const ctx = await requireTenantContext();
  if (!hasPermission(ctx.role, { ai: ["read"] })) notFound();

  const [settings, credentials, suggestions, stale] = await Promise.all([
    getOrgSettings(ctx),
    listOrgLlmCredentials(ctx),
    listOrgSuggestions(ctx),
    listOrgStaleBrainEntries(ctx),
  ]);
  const reviews = suggestions.filter((s) => s.status === "pending").length;

  return (
    <main className="p-page-pad mx-auto max-w-3xl space-y-6">
      <PageHeader title={t("title")} />
      <Card className="text-sm">
        <AiSummary
          settings={settings}
          credential={credentials[0]}
          counts={{ reviews, stale: stale.length }}
        />
      </Card>
      <AiModuleTabs />
      {children}
    </main>
  );
}
