const PROFILE_KEYS = [
  "email",
  "phone",
  "notes",
  "company",
  "jobTitle",
  "address",
  "birthday",
  "urls",
] as const;

/** Only the ficha's editable fields cross to client components — never `metadata.google` or provider extras. */
export function pickProfileMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    PROFILE_KEYS.filter((key) => key in metadata).map((key) => [key, metadata[key]]),
  );
}
