"use client";

import { Button } from "@crm/design-system/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@crm/design-system/components/dropdown-menu";
import { IconButton } from "@crm/design-system/components/icon-button";
import { toast } from "@crm/design-system/components/toast";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import {
  connectChannelConnectionAction,
  connectionLifecycleAction,
  deleteChannelConnectionAction,
} from "@/server/actions/integrations";

import { PairingPanel } from "./pairing-panel";

type QrCode = { mimeType: string; data: string };

type Lifecycle = "stop" | "restart" | "logout";

function useConnectionActions(id: string, kind: string) {
  const t = useTranslations("integrations");
  const [pending, startTransition] = useTransition();
  const [pairing, setPairing] = useState<{ qr?: QrCode } | null>(null);

  function connect() {
    startTransition(async () => {
      const result = await connectChannelConnectionAction(id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.status === "connected") {
        setPairing(null);
        toast.success(t("actions.connected"));
      } else if (kind === "waha") {
        // Connecting/pending → open the pairing panel (QR + phone code).
        setPairing({ qr: result.qrCode });
      } else {
        toast.info(t("actions.statusInfo", { status: result.status }));
      }
    });
  }

  function lifecycle(action: Lifecycle, label: string) {
    startTransition(async () => {
      const result = await connectionLifecycleAction(id, action);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (action === "logout" || action === "stop") setPairing(null);
      toast.success(label);
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteChannelConnectionAction(id);
      if (!result.ok) toast.error(result.error);
      else toast.success(t("actions.deleted"));
    });
  }

  return { pending, pairing, setPairing, connect, lifecycle, remove };
}

function ActionsMenu({
  pending,
  wahaActive,
  hasLifecycle,
  lifecycle,
  remove,
}: {
  pending: boolean;
  wahaActive: boolean;
  hasLifecycle: boolean;
  lifecycle: (action: Lifecycle, label: string) => void;
  remove: () => void;
}) {
  const t = useTranslations("integrations");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton icon="ellipsis-vertical" label={t("actions.more")} disabled={pending} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {hasLifecycle && (
          <>
            <DropdownMenuItem
              onSelect={() =>
                lifecycle(
                  "restart",
                  wahaActive ? t("actions.sessionRestarted") : t("actions.sessionRestartedQr"),
                )
              }
            >
              {t("actions.restart")}
            </DropdownMenuItem>
            {wahaActive && (
              <DropdownMenuItem onSelect={() => lifecycle("stop", t("actions.sessionStopped"))}>
                {t("actions.stop")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => lifecycle("logout", t("actions.deviceUnpaired"))}>
              {t("actions.unpair")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem variant="destructive" onSelect={remove}>
          {t("actions.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ConnectionActions({
  id,
  kind,
  status,
}: {
  id: string;
  kind: string;
  status: string;
}) {
  const t = useTranslations("integrations");
  const { pending, pairing, setPairing, connect, lifecycle, remove } = useConnectionActions(
    id,
    kind,
  );

  const wahaActive = kind === "waha" && status === "connected";
  const wahaDown = kind === "waha" && (status === "error" || status === "disconnected");

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {kind !== "site_chat" && (
          <Button variant="secondary" type="button" size="sm" disabled={pending} onClick={connect}>
            {status === "connected" ? t("actions.reconnect") : t("actions.connect")}
          </Button>
        )}
        <ActionsMenu
          pending={pending}
          wahaActive={wahaActive}
          hasLifecycle={wahaActive || wahaDown}
          lifecycle={lifecycle}
          remove={remove}
        />
      </div>
      {pairing && <PairingPanel id={id} initialQr={pairing.qr} onDone={() => setPairing(null)} />}
    </div>
  );
}
