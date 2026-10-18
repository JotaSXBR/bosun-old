// WAHA inbound-media helpers — origin guard for stamped urls and the
// candidate /api/files paths of a downloaded message. Pure functions of the
// provider's baseUrl/session so waha.ts stays under the file-size limit.

function parseMediaUrl(absolute: string): URL {
  try {
    return new URL(absolute);
  } catch {
    throw new Error("WAHA fetchMedia refused: unparseable url");
  }
}

const LOCALHOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// /api/s3/{bucket}/{key} is WAHA's S3 proxy route (WAHA_S3_PROXY_FILES)
// — the stamped media.url path is /api/s3/*, not /api/files/*.
const isWahaFilePath = (pathname: string) =>
  pathname.startsWith("/api/files/") || pathname.startsWith("/api/s3/");

/**
 * Resolves a provider-stamped media url to a safe absolute target on the
 * WAHA host. GOWS may emit relative media paths — resolve them on
 * baseUrl. media.url is provider-generated, but the api key must never
 * leave the WAHA host: same-origin passes as-is; a foreign /api/files/*
 * path is the same file on the trusted host (WAHA stamps its own
 * WAHA_BASE_URL, default http://localhost:3000) so re-root
 * pathname+search; a localhost-family origin is WAHA's own view of
 * itself — any path there is a WAHA url, re-root it the same way.
 * Anything else is refused. Origin check (not prefix): "http://waha@evil"
 * or "http://waha.evil" would pass a startsWith test and leak X-Api-Key.
 */
export function resolveMediaUrl(baseUrl: string, url: string): string {
  const absolute = url.startsWith("/") ? `${baseUrl}${url}` : url;
  const parsed = parseMediaUrl(absolute);
  if (parsed.origin === new URL(baseUrl).origin) return absolute;
  if (LOCALHOSTS.has(parsed.hostname) || isWahaFilePath(parsed.pathname)) {
    return `${baseUrl}${parsed.pathname}${parsed.search}`;
  }
  // Origin only — the path/query of a signed url must never hit logs.
  throw new Error(`WAHA fetchMedia refused: url outside the WAHA host (origin ${parsed.origin})`);
}

/**
 * http(s) urls on non-WhatsApp hosts may be pre-signed media (S3/MinIO/
 * RustFS) — internal S3 endpoints are plain http. Safe to fetch
 * anonymously: the url is stamped by WAHA's own media layer in response
 * to our authenticated downloadMedia call, and the api key must never
 * ride along. *.whatsapp.net hosts are the encrypted CDN — skipped, the
 * blob is undecryptable here anyway.
 */
export function isAnonymousFetchable(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname;
    // localhost urls are WAHA's own view of itself — fetched from our
    // container they'd hit *this* app, not WAHA.
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
    return host !== "whatsapp.net" && !host.endsWith(".whatsapp.net");
  } catch {
    return false;
  }
}

/** Extension for the common media mimetypes WAHA reports. */
function mimeExt(mimetype: string | null): string | undefined {
  switch (mimetype?.split(";")[0]?.trim().toLowerCase()) {
    case "image/webp":
      return ".webp";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "video/mp4":
      return ".mp4";
    case "audio/ogg":
      return ".ogg";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
      return ".m4a";
    case "audio/webm":
      return ".webm";
    case "application/pdf":
      return ".pdf";
    default:
      return undefined;
  }
}

/**
 * Candidate /api/files paths for a downloaded message. WAHA names the
 * stored object with the FULL serialized message id
 * (false_<chat>_<stanza>) — S3 keys are {session}/{serializedId}.{ext}
 * and the proxied url drops the session dir. media.filename is the
 * bare stanza/original name and may differ, and the bare messageId
 * segment is the last resort. Extension comes from the filename, else
 * the mimetype.
 */
export function mediaFilePaths(
  session: string,
  file: { filename: string | null; messageId: string; mimetype: string | null },
): string[] {
  const { filename, messageId } = file;
  const bareId = messageId.split("_").pop();
  const ext = filename?.match(/\.[a-z0-9]+$/i)?.[0] ?? mimeExt(file.mimetype);
  const rootThenSession = (name: string) => [`/api/files/${name}`, `/api/files/${session}/${name}`];
  const sessionThenRoot = (name: string) => [`/api/files/${session}/${name}`, `/api/files/${name}`];
  return [
    ...new Set([
      ...(ext ? rootThenSession(encodeURIComponent(`${messageId}${ext}`)) : []),
      ...(filename ? sessionThenRoot(encodeURIComponent(filename)) : []),
      ...(bareId && ext ? sessionThenRoot(encodeURIComponent(`${bareId}${ext}`)) : []),
    ]),
  ];
}
