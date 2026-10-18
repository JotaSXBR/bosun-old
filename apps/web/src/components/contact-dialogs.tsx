"use client";

import { Button } from "@crm/design-system/components/button";
import { Dialog } from "@crm/design-system/components/dialog";
import { Input } from "@crm/design-system/components/input";
import { Label } from "@crm/design-system/components/label";
import { Select } from "@crm/design-system/components/select";
import { toast } from "@crm/design-system/components/toast";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { ContactSelect } from "@/components/contact-select";
import { useOnOpen } from "@/lib/use-on-open";
import { createContactAction, startOutboundConversationAction } from "@/server/actions/contacts";
import type { WahaConnectionPick } from "@/server/services";

interface ContactFormState {
  displayName: string;
  phone: string;
  email: string;
}

/**
 * Manual contact creation — display name + strict international phone
 * (normalized to a WhatsApp chat id by the service) + optional e-mail.
 * `onCreated` receives the new/existing contact id so callers (deal form,
 * new-conversation dialog) can select it right away.
 */
export function NewContactDialog({
  open,
  onOpenChange,
  initialName,
  initialPhone,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  initialPhone?: string;
  onCreated?: (id: string) => void;
}) {
  const t = useTranslations("contacts");
  const router = useRouter();
  const initialForm = (): ContactFormState => ({
    displayName: initialName ?? "",
    phone: initialPhone ?? "",
    email: "",
  });
  const [form, setFormState] = useState<ContactFormState>(initialForm);
  useOnOpen(open, () => setFormState(initialForm()));
  const [pending, startTransition] = useTransition();
  const setForm = (patch: Partial<ContactFormState>) =>
    setFormState((prev) => ({ ...prev, ...patch }));

  function submit() {
    startTransition(async () => {
      const result = await createContactAction({
        displayName: form.displayName,
        phone: form.phone,
        email: form.email.trim() || undefined,
      });
      if (result.ok) {
        toast.success(t("created"));
        onOpenChange(false);
        onCreated?.(result.id);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  const canSubmit = form.displayName.trim() && form.phone.trim() && !pending;

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={t("newTitle")}
      footer={
        <Button variant="primary" onClick={submit} disabled={!canSubmit}>
          {t("createSubmit")}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="contact-name">{t("name")}</Label>
          <Input
            shape="rounded"
            id="contact-name"
            value={form.displayName}
            onChange={(e) => setForm({ displayName: e.target.value })}
            maxLength={120}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contact-phone">{t("phone")}</Label>
          <Input
            shape="rounded"
            id="contact-phone"
            value={form.phone}
            onChange={(e) => setForm({ phone: e.target.value })}
            placeholder="+55 11 99999-8888"
            inputMode="tel"
            maxLength={32}
          />
          <p className="text-ink-muted text-xs">{t("phoneHint")}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contact-email">{t("email")}</Label>
          <Input
            shape="rounded"
            id="contact-email"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ email: e.target.value })}
            maxLength={200}
          />
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Outbound-first: pick a contact (or create one inline) + a connected WAHA
 * connection, open the ticket and land on the conversation to type the
 * first message. When `contact` is passed the picker is skipped.
 */
export function NewConversationDialog({
  open,
  onOpenChange,
  connections,
  contact,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: WahaConnectionPick[];
  contact?: { id: string; label: string };
}) {
  const t = useTranslations("contacts");
  const router = useRouter();
  const [contactId, setContactId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [contactBump, setContactBump] = useState(0);
  // Name typed in the picker when "create" was clicked; null = the inline dialog is closed.
  const [createName, setCreateName] = useState<string | null>(null);
  useOnOpen(open, () => {
    setContactId(contact?.id ?? "");
    setConnectionId(connections[0]?.id ?? "");
  });
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const result = await startOutboundConversationAction({
        channelConnectionId: connectionId,
        contactId,
      });
      if (result.ok) {
        toast.success(t("conversationStarted"));
        onOpenChange(false);
        router.push(`/app/inbox/${result.id}`);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={() => onOpenChange(false)}
        title={t("newConversation")}
        footer={
          <Button
            variant="primary"
            onClick={submit}
            disabled={!contactId || !connectionId || pending}
          >
            {t("startConversation")}
          </Button>
        }
      >
        <div className="space-y-4">
          {contact ? (
            <div className="space-y-1.5">
              <Label>{t("contact")}</Label>
              <p className="text-sm">{contact.label}</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>{t("contact")}</Label>
              <ContactSelect
                value={contactId}
                onChange={(id) => setContactId(id)}
                refreshKey={contactBump}
                onlyWhatsApp
                onCreateClick={setCreateName}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="conv-connection">{t("connection")}</Label>
            {connections.length === 0 ? (
              <p className="text-ink-muted text-sm">{t("noConnection")}</p>
            ) : (
              <Select
                options={connections.map((c) => ({ value: c.id, label: c.name }))}
                value={connectionId || undefined}
                onChange={setConnectionId}
                id="conv-connection"
              />
            )}
          </div>
        </div>
      </Dialog>
      <NewContactDialog
        open={createName !== null}
        onOpenChange={(next) => !next && setCreateName(null)}
        initialName={createName ?? ""}
        onCreated={(id) => {
          setContactId(id);
          setContactBump((b) => b + 1);
        }}
      />
    </>
  );
}
