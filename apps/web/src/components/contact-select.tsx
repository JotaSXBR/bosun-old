"use client";

import { isWhatsAppChatId } from "@crm/core/contacts/phone";
import { Button } from "@crm/design-system/components/button";
import { Input } from "@crm/design-system/components/input";
import { Select } from "@crm/design-system/components/select";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { searchContactsAction } from "@/server/actions/leads";
import type { ContactPickRow } from "@/server/services";

function pickOptions(contacts: ContactPickRow[], onlyWhatsApp: boolean) {
  const rows = onlyWhatsApp ? contacts.filter((c) => isWhatsAppChatId(c.channelUserId)) : contacts;
  return rows.map((c) => ({ value: c.id, label: c.displayName ?? c.channelUserId }));
}

/** Debounced contact search; `searched` flips once the first response lands. */
function useContactSearch(query: string, refreshKey: number) {
  const [contacts, setContacts] = useState<ContactPickRow[]>([]);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      void searchContactsAction(query || undefined).then((r) => {
        if (r.ok) setContacts(r.data);
        setSearched(true);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [query, refreshKey]);
  return { contacts, searched };
}

type ContactSelectProps = {
  value: string;
  onChange: (id: string, contact?: ContactPickRow) => void;
  onCreateClick?: (query: string) => void;
  /** Bump to refetch (e.g. after an inline contact creation). */
  refreshKey?: number;
  /** Restrict the options to contacts with a WhatsApp identity (outbound-first). */
  onlyWhatsApp?: boolean;
};

/**
 * Shared contact picker: debounced search + Select. When `onCreateClick`
 * is given, a "Novo contato" button appears so the parent can open the
 * create-contact dialog (the typed query is handed back as initial name).
 */
export function ContactSelect({
  value,
  onChange,
  onCreateClick,
  refreshKey = 0,
  onlyWhatsApp = false,
}: ContactSelectProps) {
  const t = useTranslations("contacts");
  const [query, setQuery] = useState("");
  const { contacts, searched } = useContactSearch(query, refreshKey);
  const options = pickOptions(contacts, onlyWhatsApp);

  return (
    <div className="space-y-2">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("searchContact")}
        aria-label={t("searchContact")}
      />
      <Select
        options={options}
        value={value || undefined}
        onChange={(id) =>
          onChange(
            id,
            contacts.find((c) => c.id === id),
          )
        }
        placeholder={t("selectContact")}
        aria-label={t("contactAria")}
      />
      {searched && contacts.length === 0 && (
        <p className="text-ink-muted text-xs">{t("noContacts")}</p>
      )}
      {onCreateClick && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          iconLeft="plus"
          onClick={() => onCreateClick(query)}
        >
          {t("newContact")}
        </Button>
      )}
    </div>
  );
}
