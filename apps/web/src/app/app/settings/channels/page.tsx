import { Badge } from "@crm/design-system/components/badge";
import { Card } from "@crm/design-system/components/card";
import { EmptyState } from "@crm/design-system/templates/empty-state";
import { PageHeader } from "@crm/design-system/templates/page-header";
import { hasPermission } from "@crm/permissions";
import { headers } from "next/headers";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { googleRedirectUri } from "@/app/api/integrations/google/redirect";
import {
  getGoogleConnectionStatus,
  getGoogleContactsSyncSummary,
  listChannelConnections,
} from "@/server/services";
import { requireTenantContext } from "@/server/tenant";

import { ConnectionActions } from "./connection-actions";
import { ConnectionHealth } from "./connection-health";
import { CopyButton } from "./copy-button";
import { GoogleCard } from "./google-card";
import { NewConnectionForm } from "./new-connection-form";
import { WidgetPanel } from "./widget-panel";

// Reads the session + database → must never be prerendered at build time.
export const dynamic = "force-dynamic";

const STATUS_TONES: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  pending: "neutral",
  connected: "success",
  connecting: "warning",
  disconnected: "neutral",
  error: "danger",
};

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ google?: string }>;
}) {
  const t = await getTranslations("integrations");
  const ctx = await requireTenantContext();
  const connections = await listChannelConnections(ctx);
  const google = await getGoogleConnectionStatus(ctx);
  const googleSync =
    google?.status === "connected" ? await getGoogleContactsSyncSummary(ctx) : null;
  const { google: googleFlash } = await searchParams;
  // §7.7 of the IA spec: integrations:manage — was `role !== "agent"`,
  // which wrongly included the read-only viewer.
  const canManage = ctx.isPlatformAdmin || hasPermission(ctx.role, { integrations: ["manage"] });

  const headerList = await headers();
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3000";
  const origin = `${proto}://${host}`;

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <PageHeader
        title={t("title")}
        right={
          <Link href="/app/settings" className="text-ink-muted text-sm">
            {t("back")}
          </Link>
        }
      />

      {canManage && <NewConnectionForm />}

      <GoogleCard
        connection={
          google && {
            status: google.status,
            accountEmail: google.accountEmail,
            lastCheckedAt: google.lastCheckedAt?.toISOString() ?? null,
            lastError: google.lastError,
          }
        }
        sync={googleSync}
        canManage={canManage}
        redirectUri={googleRedirectUri()}
        flash={googleFlash ?? null}
      />

      <Card title={t("connections")}>
        {connections.length === 0 ? (
          <EmptyState icon="plug" title={t("noConnections")} />
        ) : (
          <ul className="space-y-4" data-testid="connection-list">
            {connections.map((conn) => {
              const webhookUrl = `${origin}/api/webhooks/channels/${conn.webhookToken}`;
              return (
                <li key={conn.id} className="space-y-2 border-b pb-4 last:border-0">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <span className="font-medium">{conn.name}</span>
                      <span className="text-ink-muted text-xs uppercase">{conn.kind}</span>
                      <Badge
                        tone={STATUS_TONES[conn.status] ?? "neutral"}
                        data-testid={`status-${conn.id}`}
                      >
                        {t.has(`status.${conn.status}`) ? t(`status.${conn.status}`) : conn.status}
                      </Badge>
                      {conn.externalRef && (
                        <span className="text-ink-muted text-xs">{conn.externalRef}</span>
                      )}
                    </div>
                    {canManage && (
                      <ConnectionActions id={conn.id} kind={conn.kind} status={conn.status} />
                    )}
                  </div>
                  <ConnectionHealth id={conn.id} kind={conn.kind} />
                  {conn.kind === "site_chat" ? (
                    <WidgetPanel
                      connectionId={conn.id}
                      webhookToken={conn.webhookToken}
                      origin={origin}
                      config={conn.metadata as Record<string, string>}
                      canManage={canManage}
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <code className="bg-raised flex-1 truncate rounded-xs px-2 py-1 text-xs">
                        {webhookUrl}
                      </code>
                      <CopyButton value={webhookUrl} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </main>
  );
}
