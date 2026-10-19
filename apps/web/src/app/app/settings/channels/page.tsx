import type { TenantContext } from "@crm/core";
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

type Google = Awaited<ReturnType<typeof getGoogleConnectionStatus>>;

async function googleSyncView(ctx: TenantContext, google: Google) {
  if (google?.status !== "connected") return null;
  return {
    ...(await getGoogleContactsSyncSummary(ctx)),
    lastSweepAt: google.lastSweepAt?.toISOString() ?? null,
  };
}

async function requestOrigin(): Promise<string> {
  const headerList = await headers();
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

type Connection = Awaited<ReturnType<typeof listChannelConnections>>[number];

const googleConnectionView = (google: Google) =>
  google && {
    status: google.status,
    accountEmail: google.accountEmail,
    lastCheckedAt: google.lastCheckedAt?.toISOString() ?? null,
    lastError: google.lastError,
  };

async function ConnectionItem({
  conn,
  origin,
  canManage,
}: {
  conn: Connection;
  origin: string;
  canManage: boolean;
}) {
  const t = await getTranslations("integrations");
  const webhookUrl = `${origin}/api/webhooks/channels/${conn.webhookToken}`;
  return (
    <li className="space-y-2 border-b pb-4 last:border-0">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="font-medium">{conn.name}</span>
          <span className="text-ink-muted text-xs uppercase">{conn.kind}</span>
          <Badge tone={STATUS_TONES[conn.status] ?? "neutral"} data-testid={`status-${conn.id}`}>
            {t.has(`status.${conn.status}`) ? t(`status.${conn.status}`) : conn.status}
          </Badge>
          {conn.externalRef && <span className="text-ink-muted text-xs">{conn.externalRef}</span>}
        </div>
        {canManage && <ConnectionActions id={conn.id} kind={conn.kind} status={conn.status} />}
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
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ google?: string }>;
}) {
  const t = await getTranslations("integrations");
  const ctx = await requireTenantContext();
  const connections = await listChannelConnections(ctx);
  const google = await getGoogleConnectionStatus(ctx);
  const googleSync = await googleSyncView(ctx, google);
  const { google: googleFlash } = await searchParams;
  // §7.7 of the IA spec: integrations:manage — was `role !== "agent"`,
  // which wrongly included the read-only viewer.
  const canManage = ctx.isPlatformAdmin || hasPermission(ctx.role, { integrations: ["manage"] });

  const origin = await requestOrigin();

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
        connection={googleConnectionView(google)}
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
            {connections.map((conn) => (
              <ConnectionItem key={conn.id} conn={conn} origin={origin} canManage={canManage} />
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
