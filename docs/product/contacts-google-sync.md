# Contacts → Google sync (People API)

## Vision

Every workspace's contacts live twice: in Bosun **and** in one Google
account the org chooses. The sync is **push-only** (Bosun → Google) and
continuous — a new or updated contact lands in Google Contacts on its
own. It doubles as a backup of the contact base and enriches the
address book of the paired phone, which is what WhatsApp renders names
from.

One Google connection per workspace, even when several phones run
channel sessions. Configured and checked **via UI** — no platform envs —
following the org-BYOK precedent (`org_llm_credentials`).

## Decisions (interviewed 2026-10-15)

- **Direction: push only** for this slice. Bidirectional is a stated
  future goal — the design already persists `resourceName`/`etag` and
  writes via field masks so a pull pass reuses the same plumbing.
- **Scope: workspace** — one Google account chosen per org. Not
  per-member, never fanning the base out to N phones.
- **Trigger: automatic & continuous** — contact create/update enqueues
  a push; connecting the account runs an initial bulk sync. A backup
  you have to remember to click isn't a backup.
- **Write rules** (verified against the People API docs):
  - Match by **phone, E.164** (`+5516997524950`). Note:
    `people.searchContacts` is **prefix-phrase** matching, not exact —
    candidates are verified client-side by normalized equality before
    any write.
  - Existing Google contact → `updateContact` with `updatePersonFields`
    listing only the fields we manage — `names` always (sobrescreve);
    other mapped fields when Bosun has them. Listed fields are
    **replaced** wholesale, and `etag` is required (optimistic
    concurrency — a stale etag means re-read then retry).
    **Photo: never** — photos live on a separate endpoint
    (`updateContactPhoto`) that we simply never call.
  - Contact without phone but with email (site widget) → created with
    email only; match by email.
  - Contact with neither → skipped.
  - Only **standard People fields** — zero custom/`userDefined`.
    Singleton fields (`names`, `biographies`, `birthdays`, `genders`)
    must carry exactly one value or `createContact` 400s.
- **Deletes don't propagate** in this slice. Future: deleting a contact
  in Bosun renames the Google contact to `Excluído`/`Bloqueado` —
  recorded here so the write path keeps `resourceName` reachable.

## Contact model

`contacts` carries a profile with the standard People fields — stored
**flat** in `metadata` (no `profile` nesting, so no data migration and the
site_chat ingest keeps working), validated by zod in
`updateContactProfileInput`, no bespoke columns per field. Implemented in
slice 2; the data lives in Bosun and works with or without a Google
connection:

| Bosun (`metadata` key)    | People `personFields`       |
| ------------------------- | --------------------------- |
| `displayName` (column)    | `names.displayName`         |
| `channelUserId` (E.164)   | `phoneNumbers[0].value`     |
| `email`                   | `emailAddresses`            |
| `phone` (additional)      | `phoneNumbers` (additional) |
| `company` + `jobTitle`    | `organizations`             |
| `address` (free text)     | `addresses`                 |
| `notes`                   | `biographies`               |
| `birthday` (`YYYY-MM-DD`) | `birthdays`                 |
| `urls` (list, max 5)      | `urls`                      |

Empty values clear the key. `urls` accept only `http`/`https` (the value is
mirrored to Google). The contact ficha (inbox aside, inline) and the
"Editar" dialog on `/app/contacts` edit these fields. In slice 3, updating
any of them enqueues a push **only when a Google connection exists**; when
Google is connected later, the initial bulk sync mirrors what is already in
Bosun. Fields the ficha doesn't expose simply don't sync; nothing custom is
ever written.

Sync state rides on the contact row (`metadata.google`:
`resourceName`, `etag`, `lastSyncedAt`, payload hash for no-op skips).
`etag` comes from `person.metadata.sources.etag` and is mandatory on
every `updateContact` — and is exactly what the future pull direction
needs.

## Connection (UI, workspace-scoped)

New `external_connections` table per `domain-model.md`: org,
`provider='google'`, encrypted token bundle (access + refresh +
expiry + scopes + account email), status, RLS tenant policy, grants —
same shape as `channel_connections.credentialsEncrypted`.

`/app/settings/channels` (the integrations page) gets a **Google Contacts** card:

- Org pastes its Google OAuth client id/secret (BYOK — org owns the
  consent-screen app), hits **Conectar** → OAuth consent → tokens
  stored encrypted → initial bulk sync starts.
- Status surface: connected account, token health, contacts synced,
  last sync, error strip. **Verificar** re-checks the token live.
- Desconectar removes the connection (synced contacts stay in Google —
  push-only means Bosun never deletes remotely).

## Sync engine

pg-boss job `contact-google-sync` (payload: organizationId +
contactId, or a bulk cursor for the initial pass). OAuth scope:
`https://www.googleapis.com/auth/contacts`.

**Serialization is a hard requirement**: the API asks for sequential
mutate requests per user — pushes run one-at-a-time per connection
(pg-boss singleton on the connection key absorbs both dedup and
ordering), with backoff on 429. No parallel fan-out, including the
initial sync.

1. Load connection + refresh token if expired (refresh failure →
   connection `needs_reauth`, job no-ops, UI flags it).
2. Load contact; skip if no phone and no email.
3. Known `resourceName` → `people.get` for the current etag, write. New
   contact → `people.searchContacts` (after the required empty-query
   warmup the first time) for candidates, verified by exact normalized
   phone/email; hit → update path, miss → `createContact` with the full
   mapped set.
4. Store `resourceName`/`etag`/hash on `metadata.google`.

Initial bulk sync: `createContact` per missing contact (sequential);
`batchUpdateContacts` (per-contact etag, one `updateMask`) amortizes
updates over existing ones.

Rate limits: People API quotas are per-project — BYOK means each org's
quota is its own. 429/5xx → retry with backoff.

### Slice 3a — implemented (manual push)

- **Trigger**: only the "Sincronizar agora" button on the Google card
  (`integrations:manage`, connected account). It queues one
  `contact-google-sync` job per eligible contact; nothing is sent when the
  account is connected, nor when a contact is edited (that is slice 3b).
- **Queue**: `key_strict_fifo`, every job under `singletonKey
google:<organizationId>` — one Google mutation at a time per org. The
  handler always completes (a `failed` job would hold the org's key); Google
  errors are stored as `metadata.google.lastError`, unexpected errors are
  reported and not retried.
- **Eligibility**: a WhatsApp `@c.us` phone or an e-mail (`@lid` ids and
  site-chat visitors without e-mail are skipped). The card counts with the
  same rule.
- **Update mask**: a contact Bosun already mirrors is sent with the full
  field mask, so a field emptied in Bosun is cleared in Google. The first
  adoption of a pre-existing Google contact (exact phone/e-mail match)
  sends only the fields Bosun has, so the person's own data is not wiped —
  it does overwrite the fields Bosun has (name, notes, organization…).
- **Sanitization**: values with control/bidi characters are dropped and
  `urls` must be public http(s) without credentials, at the mapping exit,
  since inbound names and legacy metadata never passed the profile schema.
- **Idempotency**: `metadata.google.payloadHash` — repeating the button
  makes no Google call for unchanged contacts. Consequence: a contact
  deleted in Google is not recreated until it is edited in Bosun.
- **LGPD**: address and birthday are mirrored (user decision, 2026-10-16);
  data only leaves after the explicit click, with the account shown in the
  confirmation.
- **Known limits (3b)**: sequential enqueue inside one request, summary scan
  of all contacts on page load, no failed counter in the card, Google write
  quota (429) can leave contacts in `lastError` on very large bases.

## Non-goals (later slices)

- **Pull / bidirectional** — import existing Google contacts, remote
  change detection. Persisted `resourceName`/`etag` and the field-mask
  write path are the groundwork.
- **Delete propagation** — Bosun delete → rename `Excluído`/`Bloqueado`
  in Google (never hard-delete remotely).
- Per-member connections, multiple Google accounts per workspace.
- Contact photos/avatars in Google, custom fields, group/label sync.
- Syncing anything but contacts (calendar lives in `ai-agents.md`).
