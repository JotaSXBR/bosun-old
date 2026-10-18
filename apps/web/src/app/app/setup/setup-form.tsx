"use client";

import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import { Input } from "@crm/design-system/components/input";
import { Select } from "@crm/design-system/components/select";
import { toast } from "@crm/design-system/components/toast";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { FormEvent } from "react";
import { useState } from "react";

import { saveSetupEmailAction } from "@/server/actions/setup";

function readSetupValues(fd: FormData, provider: string): Record<string, unknown> {
  const str = (key: string) => {
    const v = fd.get(key);
    return typeof v === "string" ? v : "";
  };
  const smtpPort = str("smtpPort");
  return {
    provider,
    from: str("from"),
    resendApiKey: str("resendApiKey"),
    smtp: {
      host: str("smtpHost"),
      port: smtpPort === "" ? "" : Number(smtpPort),
      user: str("smtpUser"),
      password: str("smtpPassword"),
      secure: fd.has("smtpSecure"),
    },
  };
}

/**
 * Minimal e-mail provider form for the first-run wizard. Secrets are sent
 * raw (first save — nothing to preserve); the server stores them encrypted.
 */
export function SetupForm() {
  const t = useTranslations("setup");
  const tc = useTranslations("common");
  const router = useRouter();
  const [provider, setProvider] = useState("resend");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const values = readSetupValues(fd, provider);
    setPending(true);
    const result = await saveSetupEmailAction(values);
    setPending(false);
    if (result.ok) {
      router.push("/app");
      router.refresh();
    } else {
      toast.error(result.error);
    }
  }

  return (
    <Card title={t("title")}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Select
          id="setup-provider"
          label={t("provider")}
          options={[
            { value: "console", label: t("consoleOption") },
            { value: "resend", label: "resend" },
            { value: "smtp", label: "smtp" },
          ]}
          value={provider}
          onChange={setProvider}
        />

        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="setup-from">
            {t("from")}
          </label>
          <Input
            shape="rounded"
            id="setup-from"
            name="from"
            placeholder="Bosun <noreply@exemplo.com>"
          />
        </div>

        {provider === "resend" && (
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="setup-resend-key">
              {t("resendKey")}
            </label>
            <Input
              shape="rounded"
              id="setup-resend-key"
              name="resendApiKey"
              type="password"
              autoComplete="new-password"
              placeholder="re_..."
            />
          </div>
        )}

        {provider === "smtp" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="setup-smtp-host">
                {t("host")}
              </label>
              <Input
                shape="rounded"
                id="setup-smtp-host"
                name="smtpHost"
                placeholder="smtp.exemplo.com"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="setup-smtp-port">
                {t("port")}
              </label>
              <Input
                shape="rounded"
                id="setup-smtp-port"
                name="smtpPort"
                type="number"
                placeholder="587"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="setup-smtp-user">
                {t("user")}
              </label>
              <Input shape="rounded" id="setup-smtp-user" name="smtpUser" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="setup-smtp-password">
                {tc("password")}
              </label>
              <Input
                shape="rounded"
                id="setup-smtp-password"
                name="smtpPassword"
                type="password"
                autoComplete="new-password"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                name="smtpSecure"
                type="checkbox"
                className="border-line h-4 w-4 rounded-xs border"
              />
              {t("tls")}
            </label>
          </div>
        )}

        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? tc("saving") : t("submit")}
        </Button>
      </form>
    </Card>
  );
}
