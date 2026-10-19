"use client";

import { Button } from "@crm/design-system/components/button";
import { Dialog } from "@crm/design-system/components/dialog";
import { Input } from "@crm/design-system/components/input";
import { Label } from "@crm/design-system/components/label";
import { Select } from "@crm/design-system/components/select";
import { Textarea } from "@crm/design-system/components/textarea";
import { useTranslations } from "next-intl";

type Status = "active" | "archived";

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: boolean;
  title: string;
  setTitle: (v: string) => void;
  content: string;
  setContent: (v: string) => void;
  status: Status;
  setStatus: (v: Status) => void;
  pending: boolean;
  onSubmit: () => void;
};

type FieldsProps = Pick<
  DialogProps,
  "title" | "setTitle" | "content" | "setContent" | "status" | "setStatus" | "pending"
>;

function KnowledgeFields(props: FieldsProps) {
  const { title, setTitle, content, setContent, status, setStatus, pending } = props;
  const t = useTranslations("settings.ai.knowledge");
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="kb-title">{t("titleField")}</Label>
        <Input
          shape="rounded"
          id="kb-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          disabled={pending}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="kb-content">{t("content")}</Label>
        <Textarea
          id="kb-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          maxLength={20000}
          disabled={pending}
        />
      </div>
      <div className="space-y-1">
        <Label>{t("status")}</Label>
        <Select
          options={[
            { value: "active", label: t("statusActive") },
            { value: "archived", label: t("statusArchived") },
          ]}
          value={status}
          onChange={(v) => setStatus(v as Status)}
          disabled={pending}
        />
      </div>
    </div>
  );
}

export function KnowledgeFormDialog({
  open,
  onOpenChange,
  editing,
  onSubmit,
  ...fields
}: DialogProps) {
  const t = useTranslations("settings.ai.knowledge");
  const tc = useTranslations("common");
  const { title, content, pending } = fields;

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={editing ? t("edit") : t("new")}
      description={t("description")}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            {tc("cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={onSubmit}
            disabled={pending || !title.trim() || !content.trim()}
          >
            {editing ? tc("save") : t("create")}
          </Button>
        </>
      }
    >
      <KnowledgeFields {...fields} />
    </Dialog>
  );
}
