import { z } from "zod";

const isBidiControl = (code: number) =>
  (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);

/**
 * True for C0/DEL control characters and bidi overrides/isolates. These
 * values leave Bosun for Google, so they are rejected up front. Multi-line
 * fields keep tab, LF and CR. (A code-point scan instead of a regex: ESLint's
 * no-control-regex forbids control characters in patterns.)
 */
export function hasUnsafeChars(value: string, multiline: boolean): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || code === 0x7f;
    const keptWhitespace = multiline && (code === 0x09 || code === 0x0a || code === 0x0d);
    if ((control && !keptWhitespace) || isBidiControl(code)) return true;
  }
  return false;
}

const UNSAFE_CHARS = { error: "Contém caracteres de controle não permitidos." };
const noUnsafeChars = (value: string) => !hasUnsafeChars(value, false);
const noUnsafeCharsMultiline = (value: string) => !hasUnsafeChars(value, true);

/** http(s) site with a public domain and no embedded credentials. */
const siteUrl = z
  .httpUrl({ error: "Use um endereço http:// ou https:// com domínio válido." })
  .max(300)
  .refine(
    (value) => {
      // Refinements must not throw: an unparseable value is already reported by httpUrl.
      if (!URL.canParse(value)) return true;
      const url = new URL(value);
      return url.username === "" && url.password === "";
    },
    { error: "O endereço não pode conter usuário e senha." },
  );

export const createContactInput = z.object({
  displayName: z.string().trim().min(1).max(120).refine(noUnsafeChars, UNSAFE_CHARS),
  /** International digits; normalized to a WhatsApp chatId by the service. */
  phone: z.string().trim().min(1).max(32).refine(noUnsafeChars, UNSAFE_CHARS),
  email: z.email().optional(),
});
export type CreateContactInput = z.input<typeof createContactInput>;

export const listContactsInput = z.object({
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListContactsInput = z.input<typeof listContactsInput>;

/**
 * Ficha fields — `displayName` is a column; the rest live flat in
 * `contacts.metadata` (the standard People-API-shaped profile). An empty
 * string / empty list clears the key. `urls` is user data that will be
 * mirrored to Google, so only public http(s) sites without credentials are accepted.
 */
export const updateContactProfileInput = z.object({
  contactId: z.uuid(),
  displayName: z.string().trim().min(1).max(120).refine(noUnsafeChars, UNSAFE_CHARS).optional(),
  email: z.union([z.literal(""), z.email()]).optional(),
  phone: z.string().trim().max(32).refine(noUnsafeChars, UNSAFE_CHARS).optional(),
  notes: z.string().max(4000).refine(noUnsafeCharsMultiline, UNSAFE_CHARS).optional(),
  company: z.string().trim().max(120).refine(noUnsafeChars, UNSAFE_CHARS).optional(),
  jobTitle: z.string().trim().max(120).refine(noUnsafeChars, UNSAFE_CHARS).optional(),
  address: z.string().trim().max(500).refine(noUnsafeCharsMultiline, UNSAFE_CHARS).optional(),
  birthday: z.union([z.literal(""), z.iso.date()]).optional(),
  urls: z.array(siteUrl).max(5).optional(),
});
export type UpdateContactProfileInput = z.input<typeof updateContactProfileInput>;
