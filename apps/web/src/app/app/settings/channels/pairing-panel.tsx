"use client";

import { Button } from "@crm/design-system/components/button";
import { Input } from "@crm/design-system/components/input";
import { toast } from "@crm/design-system/components/toast";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import {
  connectChannelConnectionAction,
  requestPairingCodeAction,
} from "@/server/actions/integrations";

type QrCode = { mimeType: string; data: string };

/** WAHA rotates the QR ~every 20s; polling re-fetches it on the same tick. */
const POLL_MS = 15_000;

/** Polls the connect action (a fresh QR each tick) until the session connects, then calls onDone. */
function usePairingPoll(id: string, initialQr: QrCode | undefined, onDone: () => void) {
  const t = useTranslations("integrations");
  const [qr, setQr] = useState<QrCode | undefined>(initialQr);
  const [status, setStatus] = useState("connecting");
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const result = await connectChannelConnectionAction(id);
      if (cancelled || !result.ok) return;
      setStatus(result.status);
      if (result.qrCode) setQr(result.qrCode);
      if (result.status === "connected") {
        toast.success(t("actions.connected"));
        done.current();
      }
    };
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, t]);
  return { qr, status };
}

function QrBlock({ qr, status }: { qr: QrCode | undefined; status: string }) {
  const t = useTranslations("integrations");
  return (
    <div className="flex flex-col items-start gap-4 sm:flex-row">
      <div className="flex h-48 w-48 shrink-0 items-center justify-center rounded-md bg-white">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element -- data URL, not a remote image
          <img
            src={`data:${qr.mimeType};base64,${qr.data}`}
            alt={t("pairing.qrAlt")}
            className="h-44 w-44"
          />
        ) : (
          <span className="text-ink-muted px-4 text-center text-xs">
            {status === "connecting" ? t("pairing.generatingQr") : t("pairing.qrUnavailable")}
          </span>
        )}
      </div>
      <div className="space-y-1 text-sm">
        <p className="font-medium">{t("pairing.qrTitle")}</p>
        <p className="text-ink-muted">{t("pairing.qrHelp")}</p>
      </div>
    </div>
  );
}

function PairingCodeForm({ id }: { id: string }) {
  const t = useTranslations("integrations");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState<string>();
  const [pending, setPending] = useState(false);

  async function requestCode() {
    setPending(true);
    const result = await requestPairingCodeAction(id, phone);
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setCode(result.code);
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t("pairing.phoneTitle")}</p>
      <div className="flex gap-2">
        <Input
          shape="rounded"
          value={phone}
          onChange={(event) => setPhone(event.target.value.replace(/D/g, ""))}
          placeholder="5511999998888"
          inputMode="numeric"
          className="max-w-52"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending || !phone}
          onClick={requestCode}
        >
          {t("pairing.generateCode")}
        </Button>
      </div>
      {code && (
        <p className="text-sm">
          {t("pairing.typeCode")}{" "}
          <span className="tracking-wordmark font-mono text-lg font-semibold">{code}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Pairing panel for WAHA connections — shows the rotating QR (auto-refresh
 * via the connect action) plus the "conectar com número" pairing-code flow.
 * Stops polling once the session connects.
 */
export function PairingPanel({
  id,
  initialQr,
  onDone,
}: {
  id: string;
  initialQr?: QrCode;
  onDone: () => void;
}) {
  const { qr, status } = usePairingPoll(id, initialQr, onDone);

  return (
    <div className="bg-raised/40 space-y-4 rounded-md border p-4" data-testid="pairing-panel">
      <QrBlock qr={qr} status={status} />
      <PairingCodeForm id={id} />
    </div>
  );
}
