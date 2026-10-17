import type { Database } from "@crm/db";
import { withTenant } from "@crm/db";
import { z } from "zod";

import { findContactById, updateContactGoogleSync } from "../contacts";
import {
  isEligible,
  MIRRORED_FIELDS,
  payloadHash,
  personFields,
  toPerson,
} from "./google-contact-map";
import type { GoogleOAuthClient } from "./google-oauth";
import { GoogleOAuthError } from "./google-oauth";
import type { GooglePeopleClient, GooglePerson, GooglePersonInput } from "./google-people";
import { createGooglePeopleClient, GooglePeopleError } from "./google-people";
import { getGoogleAccessToken, markGoogleNeedsReauth } from "./service";

export type GoogleSyncOutcome = "created" | "updated" | "unchanged" | "skipped" | "failed";

const mirrorSchema = z.looseObject({
  resourceName: z.string().optional(),
  payloadHash: z.string().optional(),
});
type MirrorState = z.infer<typeof mirrorSchema>;

const digits = (value: string) => value.replace(/\D/g, "");

/** Exact phone (digits) or e-mail (case-insensitive) equality — Google's search is prefix-only. */
function isSamePerson(candidate: GooglePerson, person: GooglePersonInput): boolean {
  const phones = new Set((person.phoneNumbers ?? []).map((p) => digits(p.value)));
  const emails = new Set((person.emailAddresses ?? []).map((e) => e.value.toLowerCase()));
  return (
    candidate.phones.some((p) => phones.has(digits(p))) ||
    candidate.emails.some((e) => emails.has(e.toLowerCase()))
  );
}

async function findCandidate(
  people: GooglePeopleClient,
  accessToken: string,
  person: GooglePersonInput,
): Promise<GooglePerson | null> {
  const queries = [
    ...(person.phoneNumbers ?? []).map((p) => p.value),
    ...(person.emailAddresses ?? []).map((e) => e.value),
  ];
  for (const query of queries) {
    const found = (await people.searchContacts({ accessToken, query })).find((c) =>
      isSamePerson(c, person),
    );
    if (found) return found;
  }
  return null;
}

/** Google refused a token that looked valid (consent or scope revoked): reconnect needed. */
const rejectsCredentials = (error: unknown): error is GooglePeopleError =>
  error instanceof GooglePeopleError &&
  (error.code === "unauthorized" || error.code === "forbidden");

/** Creates, or updates with the etag; on a conflict rereads once and retries. */
async function push(
  people: GooglePeopleClient,
  accessToken: string,
  person: GooglePersonInput,
  current: GooglePerson | null,
  ours: boolean,
): Promise<GooglePerson> {
  if (!current) return people.createContact({ accessToken, person });
  // A contact we already mirror gets the full mask, so a field emptied in
  // Bosun is cleared in Google; a first adoption only touches what we send.
  const fields = ours ? MIRRORED_FIELDS : personFields(person);
  const update = (target: GooglePerson) =>
    people.updateContact({ accessToken, current: target, person, fields });
  try {
    return await update(current);
  } catch (error) {
    if (!(error instanceof GooglePeopleError) || error.code !== "conflict") throw error;
    const fresh = await people.getContact({ accessToken, resourceName: current.resourceName });
    if (!fresh) throw error;
    return update(fresh);
  }
}

/**
 * Internal — trusted system path (the sync job), no role check. Mirrors one
 * contact into the org's connected Google account: reuses the stored
 * `resourceName`, else adopts an exact phone/e-mail match, else creates.
 * Unchanged payloads never reach Google. A Google/OAuth failure is recorded
 * in `metadata.google.lastError` and reported as "failed" (never thrown).
 */
export async function syncContactToGoogle(
  db: Database,
  input: { organizationId: string; contactId: string },
  deps: { oauth?: GoogleOAuthClient; people?: GooglePeopleClient } = {},
): Promise<GoogleSyncOutcome> {
  const { organizationId, contactId } = input;
  const contact = await withTenant(db, organizationId, (tx) => findContactById(tx, contactId));
  if (contact?.organizationId !== organizationId || !isEligible(contact)) return "skipped";

  // Corrupted jsonb is treated as "never synced" instead of crashing the job.
  const mirror: MirrorState = mirrorSchema.catch({}).parse(contact.metadata.google ?? {});
  const person = toPerson(contact);
  const hash = payloadHash(person);
  if (mirror.resourceName && mirror.payloadHash === hash) return "unchanged";

  const save = (google: Record<string, unknown>) =>
    withTenant(db, organizationId, (tx) =>
      updateContactGoogleSync(tx, organizationId, contactId, google),
    );

  try {
    const token = await getGoogleAccessToken(db, organizationId, deps.oauth);
    if (!token) return "skipped";
    const { accessToken } = token;
    const people = deps.people ?? createGooglePeopleClient();

    const known = mirror.resourceName
      ? await people.getContact({ accessToken, resourceName: mirror.resourceName })
      : null;
    const current = known ?? (await findCandidate(people, accessToken, person));

    const saved = await push(people, accessToken, person, current, known !== null);
    await save({
      resourceName: saved.resourceName,
      etag: saved.source?.etag ?? null,
      payloadHash: hash,
      lastSyncedAt: new Date().toISOString(),
    });
    return current ? "updated" : "created";
  } catch (error) {
    if (!(error instanceof GooglePeopleError || error instanceof GoogleOAuthError)) throw error;
    await save({ ...mirror, lastError: error.code });
    if (rejectsCredentials(error)) await markGoogleNeedsReauth(db, organizationId, error.code);
    return "failed";
  }
}
