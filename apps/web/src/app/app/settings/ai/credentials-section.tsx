"use client";

import type { LlmCredentialPublic } from "@crm/core/ai";
import { Badge } from "@crm/design-system/components/badge";
import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import { toast } from "@crm/design-system/components/toast";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

import { deleteLlmCredentialAction } from "@/server/actions/ai";

import { CredentialCreateForm } from "./credential-form";

function CredentialItem({
  cred,
  canManage,
  pending,
  onRemove,
}: {
  cred: LlmCredentialPublic;
  canManage: boolean;
  pending: boolean;
  onRemove: () => void;
}) {
  const t = useTranslations("settings.ai.credentials");
  return (
    <li className="flex items-center justify-between gap-3 border-b pb-2 last:border-0">
      <div className="flex items-center gap-2 text-sm">
        <Badge tone="neutral">{cred.provider}</Badge>
        <span className="font-medium">{cred.label ?? t("unlabeled")}</span>
        <span className="text-ink-muted">{cred.model}</span>
        <span className="text-ink-muted text-xs">
          {t("priority")} {cred.priority}
        </span>
        {cred.zdr && <Badge tone="neutral">ZDR</Badge>}
        {cred.status !== "active" && <Badge tone="neutral">{t("statusDisabled")}</Badge>}
      </div>
      {canManage && (
        <Button size="sm" variant="danger" disabled={pending} onClick={onRemove}>
          {t("remove")}
        </Button>
      )}
    </li>
  );
}

export function CredentialsSection({
  credentials,
  canManage,
}: {
  credentials: LlmCredentialPublic[];
  canManage: boolean;
}) {
  const t = useTranslations("settings.ai.credentials");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const remove = (cred: LlmCredentialPublic) => {
    if (!window.confirm(t("deleteConfirm", { label: cred.label ?? cred.id }))) return;
    startTransition(async () => {
      const result = await deleteLlmCredentialAction(cred.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(t("deleted"));
      router.refresh();
    });
  };

  return (
    <Card bodyClassName="space-y-4" title={t("title")} subtitle={t("description")}>
      {credentials.length === 0 ? (
        <p className="text-ink-muted text-sm" data-testid="credentials-empty">
          {t("empty")}
        </p>
      ) : (
        <ul className="space-y-2" data-testid="credential-list">
          {credentials.map((cred) => (
            <CredentialItem
              key={cred.id}
              cred={cred}
              canManage={canManage}
              pending={pending}
              onRemove={() => remove(cred)}
            />
          ))}
        </ul>
      )}
      {canManage && <CredentialCreateForm />}
    </Card>
  );
}
