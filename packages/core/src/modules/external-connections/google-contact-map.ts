import { createHash } from "node:crypto";

import { hasUnsafeChars } from "../contacts";
import type { GooglePersonField, GooglePersonInput } from "./google-people";

/** The slice of a contact row the Google mirror reads. */
export type MappableContact = {
  channelUserId: string;
  displayName: string | null;
  metadata: Record<string, unknown>;
};

// WhatsApp `@c.us` ids carry the phone number; `@lid` ids are opaque and are NOT numbers.
const CHANNEL_PHONE = /^([1-9]\d{7,14})@c\.us$/;
const BIRTHDAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_URLS = 5;

/**
 * Trimmed non-empty string, or undefined. Values with control/bidi characters
 * are dropped: metadata can predate (or bypass) the profile schema's guard,
 * and this is the single exit towards Google.
 */
const text = (value: unknown, multiline = false): string | undefined => {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return hasUnsafeChars(value, multiline) ? undefined : value.trim();
};

/** Public http(s) site without credentials — same rule as the profile schema. */
const safeUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
};

const digits = (value: string) => value.replace(/\D/g, "");

/** E.164 phone of a WhatsApp contact, or null (e.g. `@lid`, site-chat visitors). */
function channelPhone(channelUserId: string): string | null {
  const match = CHANNEL_PHONE.exec(channelUserId);
  return match ? `+${match[1]}` : null;
}

/** A contact is mirrored only if it has a phone number or an e-mail to match on. */
export function isEligible(contact: MappableContact): boolean {
  return channelPhone(contact.channelUserId) !== null || text(contact.metadata.email) !== undefined;
}

const names = (c: MappableContact): GooglePersonInput => {
  const name = text(c.displayName);
  return name ? { names: [{ unstructuredName: name }] } : {};
};

const phoneNumbers = (c: MappableContact): GooglePersonInput => {
  const channel = channelPhone(c.channelUserId);
  const extra = text(c.metadata.phone);
  const values = [channel, extra && digits(extra) !== digits(channel ?? "") ? extra : null];
  const list = values.filter((v): v is string => v !== null).map((value) => ({ value }));
  return list.length > 0 ? { phoneNumbers: list } : {};
};

const emailAddresses = (c: MappableContact): GooglePersonInput => {
  const email = text(c.metadata.email);
  return email ? { emailAddresses: [{ value: email }] } : {};
};

const organizations = (c: MappableContact): GooglePersonInput => {
  const name = text(c.metadata.company);
  const title = text(c.metadata.jobTitle);
  if (!name && !title) return {};
  return { organizations: [{ ...(name ? { name } : {}), ...(title ? { title } : {}) }] };
};

const addresses = (c: MappableContact): GooglePersonInput => {
  const formattedValue = text(c.metadata.address, true);
  return formattedValue ? { addresses: [{ formattedValue }] } : {};
};

const biographies = (c: MappableContact): GooglePersonInput => {
  const value = text(c.metadata.notes, true);
  return value ? { biographies: [{ value, contentType: "TEXT_PLAIN" }] } : {};
};

/** Always sets `date` (the People API asks clients to), and only for a real calendar day. */
const birthdays = (c: MappableContact): GooglePersonInput => {
  const match = BIRTHDAY.exec(text(c.metadata.birthday) ?? "");
  if (!match) return {};
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const real = new Date(Date.UTC(year, month - 1, day));
  const valid =
    year >= 1 &&
    real.getUTCFullYear() === year &&
    real.getUTCMonth() === month - 1 &&
    real.getUTCDate() === day;
  return valid ? { birthdays: [{ date: { year, month, day } }] } : {};
};

const urls = (c: MappableContact): GooglePersonInput => {
  const raw = c.metadata.urls;
  const list = Array.isArray(raw) ? raw : [];
  const values = list
    .map((v) => text(v))
    .filter((v): v is string => v !== undefined && safeUrl(v))
    .slice(0, MAX_URLS);
  return values.length > 0 ? { urls: values.map((value) => ({ value })) } : {};
};

/**
 * Bosun contact → the People `Person` fields we mirror. Only fields with a
 * value are present (singleton fields carry at most one value, as the API
 * demands); photo, custom fields and sync state are never included.
 */
export function toPerson(contact: MappableContact): GooglePersonInput {
  return {
    ...names(contact),
    ...phoneNumbers(contact),
    ...emailAddresses(contact),
    ...organizations(contact),
    ...addresses(contact),
    ...biographies(contact),
    ...birthdays(contact),
    ...urls(contact),
  };
}

/** Every field Bosun owns on a Person. */
export const MIRRORED_FIELDS: GooglePersonField[] = [
  "names",
  "phoneNumbers",
  "emailAddresses",
  "organizations",
  "addresses",
  "biographies",
  "birthdays",
  "urls",
];

/** The mask for a first adoption: exactly what we send, so a person's own data is never wiped. */
export function personFields(person: GooglePersonInput): GooglePersonField[] {
  return Object.keys(person) as GooglePersonField[];
}

/** Stable digest of the mirrored payload — equal hash means nothing to push. */
export function payloadHash(person: GooglePersonInput): string {
  return createHash("sha256").update(JSON.stringify(person)).digest("hex");
}
