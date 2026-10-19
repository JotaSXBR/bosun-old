// Shared helpers for the public /api/widget/* endpoints — CORS for
// cross-origin embeds + a single-instance in-memory rate limiter.

import { NotFoundError } from "@crm/core";
import { captureException } from "@crm/observability";
import type { z } from "zod";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
} as const;

export function corsJson(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, { ...init, headers: { ...CORS_HEADERS, ...init?.headers } });
}

export function corsOptions(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Parses a JSON body against a schema; the failure arm carries the ready 400 response. */
export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ data: T } | { response: Response }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { response: corsJson({ ok: false, error: "invalid_json" }, { status: 400 }) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { response: corsJson({ ok: false, error: "invalid_input" }, { status: 400 }) };
  }
  return { data: parsed.data };
}

/** 404 with the route-specific code for an unknown token; any other error is reported as 500. */
export function widgetErrorResponse(error: unknown, route: string, notFound: string): Response {
  if (error instanceof NotFoundError) {
    return corsJson({ ok: false, error: notFound }, { status: 404 });
  }
  captureException(error, { route });
  return corsJson({ ok: false, error: "internal" }, { status: 500 });
}

const buckets = new Map<string, { count: number; resetAt: number }>();
let callsSinceSweep = 0;

/** Every 500th call drops the expired buckets so the map cannot grow without bound. */
function sweepExpiredBuckets(now: number): void {
  if (++callsSinceSweep < 500) return;
  callsSinceSweep = 0;
  for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
}

/**
 * Fixed-window limiter keyed by an arbitrary string (ip, session token).
 * Process-local — correct while the app runs a single instance; Redis
 * move is tracked in TODO when multi-instance lands.
 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  sweepExpiredBuckets(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/**
 * Client IP for rate limiting. The app runs behind exactly one trusted
 * proxy (Coolify/Traefik), which appends the peer IP to X-Forwarded-For —
 * so the LAST hop is the real client. Earlier hops are client-supplied
 * and must not be trusted: a forged first hop would otherwise let an
 * attacker rotate the rate-limit key.
 */
export function clientIp(request: Request): string {
  const hops = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops?.at(-1) ?? "unknown";
}
