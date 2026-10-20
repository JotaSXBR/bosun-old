# Contact identity (v1, front 1)

Status: **draft** — decisions marked _Open_ need the founder before the plan.
Context: `docs/intent/bosun-v1.md` (front 1). Builds on
`channel-whatsapp.md` §8 and `contacts-google-sync.md`.

## Problem

WAHA (GOWS) delivers many chats as `<lid>@lid`, an opaque id that is **not** a
phone number. Today `wahaToInbound` stores that raw `from` in
`contacts.channel_user_id`, so:

- the contact is born with no phone, only a push name;
- it never matches an existing contact (manual, Google-mirrored) that holds the
  same person by `<phone>@c.us` — a duplicate empty contact appears;
- `channelPhone` (Google mirror) and `isEligible` skip it, so it is never
  mirrored or matched to Google.

## Decision (founder, 2026-10-20)

**The phone is the identity.** `<digits>@c.us` is the canonical
`channel_user_id`; the LID is only an alias that resolves to it.

## Behavior

1. **Resolve on inbound.** For an `@lid` sender, take the phone from the
   payload `_data.Info.SenderAlt` when present; else ask WAHA
   `GET /api/{session}/lids/{lid}` (`pn` is `null` when unknown).
   _Verified on staging 2026-10-20_ (WAHA 2026.9.2 GOWS): the webhook carries
   `from: "<lid>@lid"` and `_data.Info.SenderAlt: "<digits>:<device>@s.whatsapp.net"`
   (fixture `waha-webhooks.json`). The `:<device>` suffix must be stripped:
   `5516997524950:53@s.whatsapp.net` → `5516997524950@c.us`. `wahaMessageSchema`
   reads only `PushName` today, so it must also expose `SenderAlt`.
2. **Resolved →** `upsertContact` keyed by `<pn>@c.us`. An existing contact
   with that key (manual, from a prior `@c.us` message) is reused; the LID is
   stored as an alias on it.
3. **Unresolved →** provisional contact keyed by the LID (today's behavior).
   It is retried on its next inbound message and when opened; on success it is
   promoted/merged per 4.
4. **Merge.** If a contact exists under the LID and another under the phone,
   the LID contact is merged into the phone one: conversations (`contact_id`
   and `external_id`), messages, deals and brain references are repointed;
   `displayName` precedence is manual > Google > push name; the LID row is
   deleted. Idempotent, one transaction, tenant-scoped.
5. **Backfill.** A one-off job resolves existing LID contacts and applies 4.
   No production data is at stake (dev/staging only), so no elaborate
   rollback; an integration test proves no message or conversation is lost.
6. **Outbound** to a resolved contact uses the phone chat id (works with
   `checkNumberStatus`); unresolved contacts keep today's LID behavior.

## New contact → Google (People API format)

The phone is what lets a new contact be saved to the founder's Google
Contacts. The existing mirror (`toPerson`) already creates when no match is
found; once the identity is `@c.us` the contact becomes eligible. Payload shape
per People API `people.createContact` (`Person`):

- `phoneNumbers: [{ value: "+<E.164>" }]` — `canonicalForm` is output only;
  `type` is optional (`mobile` is a predefined value, plan decides whether to
  set it).
- `names: [{ unstructuredName: <displayName> }]` — `names` is a **singleton**
  field: at most one entry, or Google answers 400.
- A new contact is pushed promptly (enqueue on creation), not only by the
  10-minute sweep. Matching before create stays: search by phone, adopt an exact
  match instead of duplicating.

## Data

LID alias stored in `contacts.metadata.lid` with a partial unique index on
`(organization_id, (metadata->>'lid'))` — no new table (simplest sufficient).
_Plan decides_ if a real `contact_aliases` table is warranted instead.
Tenant isolation checklist (`CLAUDE.md`) applies to any new table/index.

## Security / trust boundary

- The WAHA payload and `/lids` response are zod-validated; a malformed `pn`
  never becomes an identity (E.164 shape `^[1-9]\d{7,14}@c\.us$` only).
- `organizationId` always from the connection row, never the payload.
- Control/bidi characters and `user:pass@` URLs in profile fields stay rejected
  (open slice-2 review items in `TODO.md`) — AI-suggested fields flow to Google.

## Open

- _Open (founder)_: should an incoming phone also **pull** the name/company
  from the Google contact that already exists (Google → Bosun)? Today the
  mirror is push-only; the founder's complaint is that the LID contact did not
  reuse the existing Google contact.
- _Open_: address and birthday mirrored to Google by default or by org opt-in.

## Fontes consultadas

| Tema                       | Versão                                     | Fonte                                               | Data       | Confirmou                                                                                                                   |
| -------------------------- | ------------------------------------------ | --------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| WAHA LID → phone endpoints | docs atuais; engine GOWS                   | Context7 `/devlikeapro/waha-docs` (how-to/contacts) | 2026-10-20 | `GET /api/{session}/lids/{lid}` → `{lid, pn}`; `pn: null` quando desconhecido; suportado no GOWS                            |
| `SenderAlt` no payload     | changelog `2026.8.1` (GOWS)                | Context7 `/devlikeapro/waha-docs` (changelog)       | 2026-10-20 | GOWS preenche `_data.Info.SenderAlt` a partir do LID store                                                                  |
| Versão do WAHA em uso      | `2026.9.2` (GOWS), informada pelo fundador | Staging (Coolify)                                   | 2026-10-20 | `2026.9.2` ≥ `2026.8.1`, logo `SenderAlt` vem do LID store; `/lids/{lid}` existe no GOWS. Validar o payload real no staging |
