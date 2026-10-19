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

function ContactFormFields({
  form,
  setForm,
}: {
  form: ContactFormState;
  setForm: (patch: Partial<ContactFormState>) => void;
}) {
  const t = useTranslations("contacts");
  return (
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
  );
}

/**
 * Manual contact creation — display name + strict international phone
 * (normalized to a WhatsApp chat id by the service) + optional e-mail.
 * `onCreated` receives the new/existing contact id so callers (deal form,
 * new-conversation dialog) can select it right away.
 */
type NewContactProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  initialPhone?: string;
  onCreated?: (id: string) => void;
};

function useContactForm({
  open,
  onOpenChange,
  initialName,
  initialPhone,
  onCreated,
}: NewContactProps) {
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
  return { form, setForm, submit, canSubmit };
}

export function NewContactDialog(props: NewContactProps) {
  const t = useTranslations("contacts");
  const { form, setForm, submit, canSubmit } = useContactForm(props);

  return (
    <Dialog
      open={props.open}
      onClose={() => props.onOpenChange(false)}
      title={t("newTitle")}
      footer={
        <Button variant="primary" onClick={submit} disabled={!canSubmit}>
          {t("createSubmit")}
        </Button>
      }
    >
      <ContactFormFields form={form} setForm={setForm} />
    </Dialog>
  );
}

function useStartConversation({
  connectionId,
  contactId,
  close,
}: {
  connectionId: string;
  contactId: string;
  close: () => void;
}) {
  const t = useTranslations("contacts");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const result = await startOutboundConversationAction({
        channelConnectionId: connectionId,
        contactId,
      });
      if (result.ok) {
        toast.success(t("conversationStarted"));
        close();
        router.push(`/app/inbox/${result.id}`);
      } else {
        toast.error(result.error);
      }
    });
  }
  return { pending, submit };
}

function ConversationContactField({
  contact,
  value,
  onChange,
  refreshKey,
  onCreateClick,
}: {
  contact?: { id: string; label: string };
  value: string;
  onChange: (id: string) => void;
  refreshKey: number;
  onCreateClick: (query: string) => void;
}) {
  const t = useTranslations("contacts");
  return (
    <div className="space-y-1.5">
      <Label>{t("contact")}</Label>
      {contact ? (
        <p className="text-sm">{contact.label}</p>
      ) : (
        <ContactSelect
          value={value}
          onChange={(id) => onChange(id)}
          refreshKey={refreshKey}
          onlyWhatsApp
          onCreateClick={onCreateClick}
        />
      )}
    </div>
  );
}

function ConversationConnectionField({
  connections,
  value,
  onChange,
}: {
  connections: WahaConnectionPick[];
  value: string;
  onChange: (id: string) => void;
}) {
  const t = useTranslations("contacts");
  return (
    <div className="space-y-1.5">
      <Label htmlFor="conv-connection">{t("connection")}</Label>
      {connections.length === 0 ? (
        <p className="text-ink-muted text-sm">{t("noConnection")}</p>
      ) : (
        <Select
          options={connections.map((c) => ({ value: c.id, label: c.name }))}
          value={value || undefined}
          onChange={onChange}
          id="conv-connection"
        />
      )}
    </div>
  );
}

/**
 * Outbound-first: pick a contact (or create one inline) + a connected WAHA
 * connection, open the ticket and land on the conversation to type the
 * first message. When `contact` is passed the picker is skipped.
 */
function StartButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  const t = useTranslations("contacts");
  return (
    <Button variant="primary" onClick={onClick} disabled={disabled}>
      {t("startConversation")}
    </Button>
  );
}

type NewConversationProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: WahaConnectionPick[];
  contact?: { id: string; label: string };
};

function useConversationPicker({ open, connections, contact }: NewConversationProps) {
  const [contactId, setContactId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [contactBump, setContactBump] = useState(0);
  useOnOpen(open, () => {
    setContactId(contact?.id ?? "");
    setConnectionId(connections[0]?.id ?? "");
  });
  return { contactId, setContactId, connectionId, setConnectionId, contactBump, setContactBump };
}

export function NewConversationDialog(props: NewConversationProps) {
  const { open, onOpenChange, connections, contact } = props;
  const t = useTranslations("contacts");
  const picker = useConversationPicker(props);
  const { contactId, connectionId } = picker;
  // Name typed in the picker when "create" was clicked; null = the inline dialog is closed.
  const [createName, setCreateName] = useState<string | null>(null);
  const { pending, submit } = useStartConversation({
    connectionId,
    contactId,
    close: () => onOpenChange(false),
  });

  return (
    <>
      <Dialog
        open={open}
        onClose={() => onOpenChange(false)}
        title={t("newConversation")}
        footer={<StartButton onClick={submit} disabled={!contactId || !connectionId || pending} />}
      >
        <div className="space-y-4">
          <ConversationContactField
            contact={contact}
            value={contactId}
            onChange={picker.setContactId}
            refreshKey={picker.contactBump}
            onCreateClick={setCreateName}
          />
          <ConversationConnectionField
            connections={connections}
            value={connectionId}
            onChange={picker.setConnectionId}
          />
        </div>
      </Dialog>
      <NewContactDialog
        open={createName !== null}
        onOpenChange={(next) => !next && setCreateName(null)}
        initialName={createName ?? ""}
        onCreated={(id) => {
          picker.setContactId(id);
          picker.setContactBump((b) => b + 1);
        }}
      />
    </>
  );
}
