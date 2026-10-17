"use client";

import { Badge } from "@crm/design-system/components/badge";
import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import { Input } from "@crm/design-system/components/input";
import { Label } from "@crm/design-system/components/label";
import { toast } from "@crm/design-system/components/toast";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";

import {
  connectGoogleAction,
  disconnectGoogleAction,
  syncGoogleContactsAction,
  verifyGoogleAction,
} from "@/server/actions/external-connections";

import { CopyButton } from "./copy-button";

export type GoogleConnectionView = {
  status: string;
  accountEmail: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
};

export type GoogleSyncView = { eligible: number; synced: number; lastSyncedAt: string | null };

const TONES: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  pending: "neutral",
  connected: "success",
  needs_reauth: "warning",
  error: "danger",
};

const FLASH_TOASTS = {
  ok: "success",
  denied: "warning",
  invalid: "error",
  state: "warning",
  failed: "error",
  forbidden: "error",
} as const;

function SyncSummary({ sync }: { sync: GoogleSyncView }) {
  const t = useTranslations("integrations.google");
  return (
    <p className="text-ink-muted text-sm" data-testid="google-sync-summary">
      {t("syncSummary", { eligible: sync.eligible, synced: sync.synced })}
      {sync.lastSyncedAt &&
        ` · ${t("lastSynced", { date: new Date(sync.lastSyncedAt).toLocaleString("pt-BR") })}`}
    </p>
  );
}

/** Disabled after a successful queue: jobs finish later, so the counts above lag behind. */
function SyncButton({
  sync,
  connection,
}: {
  sync: GoogleSyncView;
  connection: GoogleConnectionView | null;
}) {
  const account = connection?.accountEmail ?? "";
  const t = useTranslations("integrations.google");
  const [pending, startTransition] = useTransition();
  const [queued, setQueued] = useState(false);

  function syncNow() {
    if (!window.confirm(t("syncConfirm", { count: sync.eligible, account }))) return;
    startTransition(async () => {
      const result = await syncGoogleContactsAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setQueued(true);
      toast.success(t("syncQueued", { count: result.queued }));
    });
  }

  return (
    <Button
      variant="primary"
      size="sm"
      onClick={syncNow}
      loading={pending}
      disabled={queued || sync.eligible === 0}
    >
      {t("syncNow")}
    </Button>
  );
}

export function GoogleCard({
  connection,
  sync,
  canManage,
  redirectUri,
  flash,
}: {
  connection: GoogleConnectionView | null;
  sync: GoogleSyncView | null;
  canManage: boolean;
  redirectUri: string;
  flash: string | null;
}) {
  const t = useTranslations("integrations.google");
  const [pending, startTransition] = useTransition();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  useEffect(() => {
    if (flash && flash in FLASH_TOASTS) {
      toast[FLASH_TOASTS[flash as keyof typeof FLASH_TOASTS]](t(`flash.${flash}`));
    }
  }, [flash, t]);

  function connect() {
    startTransition(async () => {
      const result = await connectGoogleAction({ clientId, clientSecret });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      window.location.assign(result.authUrl);
    });
  }

  function verify() {
    startTransition(async () => {
      const result = await verifyGoogleAction();
      if (!result.ok) toast.error(result.error);
      else if (result.status === "connected") toast.success(t("verified"));
      else toast.warning(t(`status.${result.status}`));
    });
  }

  function disconnect() {
    if (!window.confirm(t("disconnectConfirm"))) return;
    startTransition(async () => {
      const result = await disconnectGoogleAction();
      if (!result.ok) toast.error(result.error);
      else toast.success(t("disconnected"));
    });
  }

  const connected = connection?.status === "connected";
  const errorKey = connection?.lastError ? `errors.${connection.lastError}` : null;

  return (
    <Card title={t("title")} subtitle={t("description")}>
      <div className="space-y-4" data-testid="google-card">
        {connection && (
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={TONES[connection.status] ?? "neutral"} data-testid="google-status">
              {t.has(`status.${connection.status}`)
                ? t(`status.${connection.status}`)
                : connection.status}
            </Badge>
            {connection.accountEmail && (
              <span className="text-ink-muted text-sm">{connection.accountEmail}</span>
            )}
            {connection.lastCheckedAt && (
              <span className="text-ink-muted text-xs">
                {t("lastChecked", { date: new Date(connection.lastCheckedAt).toLocaleString() })}
              </span>
            )}
          </div>
        )}
        {connection?.lastError && (
          <p className="text-danger text-sm">
            {errorKey && t.has(errorKey) ? t(errorKey) : connection.lastError}
          </p>
        )}

        {sync && <SyncSummary sync={sync} />}

        {canManage && connected && (
          <div className="flex gap-2">
            {sync && <SyncButton sync={sync} connection={connection} />}
            <Button variant="secondary" size="sm" onClick={verify} loading={pending}>
              {t("verify")}
            </Button>
            <Button variant="secondary" size="sm" onClick={disconnect} disabled={pending}>
              {t("disconnect")}
            </Button>
          </div>
        )}

        {canManage && !connected && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              connect();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="google-client-id">{t("clientId")}</Label>
                <Input
                  id="google-client-id"
                  shape="rounded"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  autoComplete="off"
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="google-client-secret">{t("clientSecret")}</Label>
                <Input
                  id="google-client-secret"
                  shape="rounded"
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  autoComplete="off"
                  required
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="google-redirect-uri">{t("redirectUri")}</Label>
              <div className="flex items-center gap-2">
                <code
                  id="google-redirect-uri"
                  className="bg-raised flex-1 truncate rounded-xs px-2 py-1 text-xs"
                >
                  {redirectUri}
                </code>
                <CopyButton value={redirectUri} />
              </div>
              <p className="text-ink-muted text-xs">{t("redirectHelp")}</p>
            </div>
            <Button variant="primary" type="submit" loading={pending}>
              {connection ? t("reconnect") : t("connect")}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}
