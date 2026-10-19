import { isWhatsAppChatId } from "@crm/core/contacts";
import { Card } from "@crm/design-system/components/card";
import { Input } from "@crm/design-system/components/input";
import { EmptyState } from "@crm/design-system/templates/empty-state";
import { PageHeader } from "@crm/design-system/templates/page-header";
import { hasPermission } from "@crm/permissions";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { EditContactButton } from "@/components/contact-edit-dialog";
import { pickProfileMetadata } from "@/lib/contact-profile";
import type { ContactListRow } from "@/server/services";
import { listContactsPage, listWahaConnections } from "@/server/services";
import { requireTenantContext } from "@/server/tenant";

import { ContactsHeaderActions, StartConversationButton } from "./contacts-actions";

// Reads the session + database → must never be prerendered at build time.
export const dynamic = "force-dynamic";

function contactEmail(metadata: ContactListRow["metadata"]): string | undefined {
  const email = (metadata as Record<string, unknown> | null)?.email;
  return typeof email === "string" ? email : undefined;
}

const PAGE_SIZE = 50;

function pageHref(query: string | undefined, target: number): string {
  const sp = new URLSearchParams();
  if (query) sp.set("q", query);
  if (target > 1) sp.set("page", String(target));
  const qs = sp.toString();
  return `/app/contacts${qs ? `?${qs}` : ""}`;
}

function PaginationNav({
  page,
  hasNextPage,
  query,
  t,
}: {
  page: number;
  hasNextPage: boolean;
  query: string | undefined;
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  if (page <= 1 && !hasNextPage) return null;
  const link = "text-ink-muted hover:text-ink text-sm transition-colors";
  return (
    <nav
      className="flex items-center justify-between border-t px-4 py-3"
      aria-label={t("pagination")}
    >
      {page > 1 ? (
        <Link href={pageHref(query, page - 1)} className={link}>
          ← {t("previousPage")}
        </Link>
      ) : (
        <span />
      )}
      {hasNextPage ? (
        <Link href={pageHref(query, page + 1)} className={link}>
          {t("nextPage")} →
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

function pagingOf(params: { q?: string; page?: string }) {
  return {
    query: params.q?.trim(),
    page: Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1),
  };
}

type Connections = Awaited<ReturnType<typeof listWahaConnections>>;

function ContactActions({
  contact,
  connections,
}: {
  contact: ContactListRow;
  connections: Connections;
}) {
  return (
    <>
      <EditContactButton
        contact={{
          id: contact.id,
          displayName: contact.displayName,
          channelUserId: contact.channelUserId,
          metadata: pickProfileMetadata(contact.metadata),
        }}
      />
      {isWhatsAppChatId(contact.channelUserId) && (
        <StartConversationButton
          connections={connections}
          contact={{ id: contact.id, label: contact.displayName ?? contact.channelUserId }}
        />
      )}
    </>
  );
}

async function ContactItem({
  contact,
  connections,
  canWrite,
}: {
  contact: ContactListRow;
  connections: Connections;
  canWrite: boolean;
}) {
  const t = await getTranslations("contacts");
  const format = await getFormatter();
  const email = contactEmail(contact.metadata);
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-3">
          <span className="truncate font-medium">
            {contact.displayName ?? contact.channelUserId}
          </span>
          <span className="text-ink-muted shrink-0 text-xs">
            {t("tickets", { count: contact.conversationCount })}
          </span>
        </div>
        <p className="text-ink-muted truncate text-xs">
          {contact.channelUserId}
          {email && ` · ${email}`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <time className="text-ink-muted text-xs">
          {format.dateTime(contact.createdAt, { dateStyle: "short" })}
        </time>
        {canWrite && <ContactActions contact={contact} connections={connections} />}
      </div>
    </li>
  );
}

async function ContactSearch({ query }: { query: string | undefined }) {
  const t = await getTranslations("contacts");
  return (
    <form className="flex gap-2" role="search">
      <Input
        type="search"
        name="q"
        defaultValue={query}
        icon="search"
        placeholder={t("searchPlaceholder")}
        aria-label={t("search")}
        className="flex-1"
      />
    </form>
  );
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const t = await getTranslations("contacts");
  const ctx = await requireTenantContext();
  const { query, page } = pagingOf(await searchParams);
  const canWrite = hasPermission(ctx.role, { messaging: ["write"] });
  const [rows, connections] = await Promise.all([
    // One extra row answers hasNextPage without a separate COUNT.
    listContactsPage(ctx, { query, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE }),
    listWahaConnections(ctx),
  ]);
  const hasNextPage = rows.length > PAGE_SIZE;
  const contacts = rows.slice(0, PAGE_SIZE);

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <PageHeader
        title={t("title")}
        right={canWrite ? <ContactsHeaderActions connections={connections} /> : undefined}
      />

      <ContactSearch query={query} />

      {contacts.length === 0 ? (
        <EmptyState icon="users" title={query ? t("emptySearch", { query }) : t("empty")} />
      ) : (
        <Card title={t("title")}>
          <ul className="divide-y" data-testid="contact-list">
            {contacts.map((contact) => (
              <ContactItem
                key={contact.id}
                contact={contact}
                connections={connections}
                canWrite={canWrite}
              />
            ))}
          </ul>
          <PaginationNav page={page} hasNextPage={hasNextPage} query={query} t={t} />
        </Card>
      )}
    </main>
  );
}
