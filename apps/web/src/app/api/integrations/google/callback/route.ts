import { getServerEnv } from "@crm/config";
import type { TenantContext } from "@crm/core";
import { AuthorizationError, DomainError } from "@crm/core";
import { completeGoogleAuthorization } from "@crm/core/external-connections";
import { getDb } from "@crm/db";
import { captureException } from "@crm/observability";

import { getTenantContext } from "@/server/tenant";

import { googleRedirectUri } from "../redirect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE_TAG = "api.google-callback";
const CARD_PATH = "/app/settings/channels";

type Outcome = "ok" | "denied" | "invalid" | "state" | "failed" | "forbidden";

/**
 * Always a redirect with no body: Google puts the authorization code in this
 * URL, so we never render a page that could leak it through scripts or the
 * Referer header (per Google's OAuth web-server guidance).
 */
function redirectTo(path: string, outcome?: Outcome): Response {
  const url = new URL(path, getServerEnv().appUrl);
  if (outcome) url.searchParams.set("google", outcome);
  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

function outcomeOf(error: unknown): Outcome {
  if (error instanceof AuthorizationError) return "forbidden";
  if (error instanceof DomainError && error.code === "GOOGLE_STATE_INVALID") return "state";
  if (!(error instanceof DomainError)) captureException(error, { route: ROUTE_TAG });
  return "failed";
}

async function finish(
  tenant: TenantContext,
  grant: { code: string; state: string },
): Promise<Response> {
  try {
    await completeGoogleAuthorization(getDb(), tenant, {
      input: {
        ...grant,
        redirectUri: googleRedirectUri(),
      },
    });
    return redirectTo(CARD_PATH, "ok");
  } catch (error) {
    return redirectTo(CARD_PATH, outcomeOf(error));
  }
}

/**
 * OAuth redirect target. The organization comes from the session (never from
 * the query); `state` must match the pending consent of that organization.
 */
export async function GET(request: Request): Promise<Response> {
  const tenant = await getTenantContext();
  if (!tenant) return redirectTo("/sign-in");

  const params = new URL(request.url).searchParams;
  if (params.get("error")) return redirectTo(CARD_PATH, "denied");
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return redirectTo(CARD_PATH, "invalid");
  return finish(tenant, { code, state });
}
