// Pure helpers for the authenticated media route — decides which stored MIME
// types may be served inline. Anything else is forced to a downloaded
// attachment so active content (HTML, SVG, JS) can never render on the app
// origin. Kept dependency-free so it is unit-testable.

const CACHE_CONTROL = "private, max-age=86400, immutable";
const MEDIA_CSP = "sandbox; default-src 'none'";

const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "application/pdf",
]);

/** MIME without parameters, lowercased (e.g. "Image/PNG; charset=x" → "image/png"). */
function normalizeMime(contentType: string | undefined | null): string | null {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase();
  return mime === "" ? null : (mime ?? null);
}

export function isInlineMediaType(contentType: string | undefined | null): boolean {
  const mime = normalizeMime(contentType);
  if (!mime) return false;
  return INLINE_TYPES.has(mime) || mime.startsWith("audio/");
}

export function mediaResponseHeaders(
  contentType: string | undefined | null,
  filename: string | undefined,
): Record<string, string> {
  const safeName = filename?.replaceAll('"', "");
  const headers: Record<string, string> = {
    "cache-control": CACHE_CONTROL,
    "content-security-policy": MEDIA_CSP,
  };
  if (isInlineMediaType(contentType)) {
    headers["content-type"] = normalizeMime(contentType) ?? "application/octet-stream";
    if (safeName) headers["content-disposition"] = `inline; filename="${safeName}"`;
  } else {
    headers["content-type"] = "application/octet-stream";
    headers["content-disposition"] = safeName ? `attachment; filename="${safeName}"` : "attachment";
  }
  return headers;
}

export function mediaResponse(
  bytes: Uint8Array,
  contentType: string | undefined | null,
  filename: string | undefined,
): Response {
  return new Response(Buffer.from(bytes), {
    headers: mediaResponseHeaders(contentType, filename),
  });
}
