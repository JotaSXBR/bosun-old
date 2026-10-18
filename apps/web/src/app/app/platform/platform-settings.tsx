"use client";

import type { PlatformSettingGroup, PlatformSettingSummary } from "@crm/core/platform";
import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import { Input } from "@crm/design-system/components/input";
import { toast } from "@crm/design-system/components/toast";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { FormEvent } from "react";

import { updatePlatformSettingAction } from "@/server/actions/platform";

type FieldDef = {
  path: string;
  label: string;
  kind?: "text" | "password" | "number" | "select" | "checkbox";
  options?: { value: string; label: string }[];
  placeholder?: string;
  secret?: boolean;
};

type T = ReturnType<typeof useTranslations>;

const groupDefs = (
  t: T,
): Record<PlatformSettingGroup, { title: string; description: string; fields: FieldDef[] }> => ({
  email: {
    title: t("platform.groups.email.title"),
    description: t("platform.groups.email.description"),
    fields: [
      {
        path: "provider",
        label: t("platform.fields.provider"),
        kind: "select",
        options: [
          { value: "console", label: t("platform.fields.consoleOption") },
          { value: "resend", label: "resend" },
          { value: "smtp", label: "smtp" },
        ],
      },
      {
        path: "from",
        label: t("platform.fields.from"),
        placeholder: "Bosun <noreply@exemplo.com>",
      },
      { path: "resendApiKey", label: t("platform.fields.resendApiKey"), secret: true },
      { path: "smtp.host", label: t("platform.fields.smtpHost") },
      {
        path: "smtp.port",
        label: t("platform.fields.smtpPort"),
        kind: "number",
        placeholder: "587",
      },
      { path: "smtp.user", label: t("platform.fields.smtpUser") },
      { path: "smtp.password", label: t("platform.fields.smtpPassword"), secret: true },
      { path: "smtp.secure", label: t("platform.fields.smtpSecure"), kind: "checkbox" },
    ],
  },
  billing: {
    title: t("platform.groups.billing.title"),
    description: t("platform.groups.billing.description"),
    fields: [
      { path: "asaasApiKey", label: t("platform.fields.asaasApiKey"), secret: true },
      {
        path: "asaasEnvironment",
        label: t("platform.fields.environment"),
        kind: "select",
        options: [
          { value: "sandbox", label: "sandbox" },
          { value: "production", label: "production" },
        ],
      },
      { path: "asaasWebhookToken", label: t("platform.fields.asaasWebhookToken"), secret: true },
    ],
  },
  meta: {
    title: t("platform.groups.meta.title"),
    description: t("platform.groups.meta.description"),
    fields: [
      { path: "phoneNumberId", label: t("platform.fields.phoneNumberId") },
      {
        path: "graphApiVersion",
        label: t("platform.fields.graphApiVersion"),
        placeholder: "v26.0",
      },
      { path: "appSecret", label: t("platform.fields.appSecret"), secret: true },
      { path: "verifyToken", label: t("platform.fields.verifyToken"), secret: true },
      { path: "accessToken", label: t("platform.fields.accessToken"), secret: true },
    ],
  },
  ai: {
    title: t("platform.groups.ai.title"),
    description: t("platform.groups.ai.description"),
    fields: [
      { path: "openaiApiKey", label: t("platform.fields.openaiApiKey"), secret: true },
      { path: "anthropicApiKey", label: t("platform.fields.anthropicApiKey"), secret: true },
    ],
  },
});

function fdString(fd: FormData, key: string): string {
  const value = fd.get(key);
  return typeof value === "string" ? value : "";
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
      obj,
    );
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  const leaf = parts.pop()!;
  const parent = parts.reduce<Record<string, unknown>>((acc, key) => {
    const next = acc[key];
    if (!next || typeof next !== "object") acc[key] = {};
    return acc[key] as Record<string, unknown>;
  }, obj);
  parent[leaf] = value;
}

function SelectInput({ id, field, current }: { id: string; field: FieldDef; current: unknown }) {
  return (
    <select
      id={id}
      name={field.path}
      defaultValue={typeof current === "string" ? current : ""}
      className="border-line shadow-control h-9 w-full rounded-md border bg-transparent px-3 text-sm"
    >
      <option value="">—</option>
      {field.options?.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function FieldInput({
  group,
  field,
  summary,
  t,
}: {
  group: string;
  field: FieldDef;
  summary: PlatformSettingSummary;
  t: T;
}) {
  const current = getPath(summary.values, field.path);
  const isSecretSet = field.secret === true && summary.secretsSet[field.path] === true;
  const id = `${group}-${field.path}`;
  const shownValue =
    typeof current === "string" || typeof current === "number" ? String(current) : "";

  let control;
  if (field.kind === "select") {
    control = <SelectInput id={id} field={field} current={current} />;
  } else if (field.kind === "checkbox") {
    control = (
      <input
        id={id}
        name={field.path}
        type="checkbox"
        defaultChecked={current === true}
        className="border-line mt-2 h-4 w-4 rounded-xs border"
      />
    );
  } else {
    control = (
      <Input
        shape="rounded"
        id={id}
        name={field.path}
        type={field.secret ? "password" : field.kind === "number" ? "number" : "text"}
        autoComplete={field.secret ? "new-password" : "off"}
        defaultValue={field.secret ? "" : shownValue}
        placeholder={isSecretSet ? t("platform.secretSet") : field.placeholder}
      />
    );
  }

  return (
    <div className="space-y-1">
      <label className="text-sm font-medium" htmlFor={id}>
        {field.label}
        {summary.dbFields.includes(field.path) && (
          <span className="text-ink-muted ml-1 text-xs">{t("platform.fromDb")}</span>
        )}
      </label>
      {control}
    </div>
  );
}

/** Reads every field of the group from the form into a nested values object. */
function collectValues(fields: FieldDef[], fd: FormData): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === "checkbox") {
      setPath(values, field.path, fd.has(field.path));
    } else if (field.kind === "number") {
      const raw = fdString(fd, field.path);
      setPath(values, field.path, raw === "" ? "" : Number(raw));
    } else {
      setPath(values, field.path, fdString(fd, field.path));
    }
  }
  return values;
}

/** One platform settings group — rendered at /app/platform/<group> (platform_admin only). */
export function PlatformGroupCard({ summary }: { summary: PlatformSettingSummary }) {
  const t = useTranslations("settings");
  const router = useRouter();
  const def = groupDefs(t)[summary.group];

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const values = collectValues(def.fields, fd);
    const result = await updatePlatformSettingAction({ group: summary.group, values });
    if (result.ok) {
      toast.success(t("platform.saved", { group: def.title }));
      router.refresh();
    } else {
      toast.error(result.error);
    }
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {def.title}
          {summary.configured ? (
            <span className="text-success text-xs font-normal">{t("platform.configured")}</span>
          ) : (
            <span className="text-ink-muted text-xs font-normal">
              {t("platform.notConfigured")}
            </span>
          )}
        </span>
      }
      subtitle={def.description}
    >
      <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        {def.fields.map((field) => (
          <FieldInput
            key={field.path}
            group={summary.group}
            field={field}
            summary={summary}
            t={t}
          />
        ))}
        <div className="sm:col-span-2">
          <Button variant="primary" type="submit">
            {t("platform.saveGroup", { group: def.title })}
          </Button>
        </div>
      </form>
    </Card>
  );
}
