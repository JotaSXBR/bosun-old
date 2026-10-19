import { z } from "zod";

// Google OAuth 2.0 (web-server flow) over plain `fetch` — no SDK dependency.
// The client id/secret are the org's own (BYOK), passed on every call.
// `fetch` is injectable so tests never reach Google.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts";
export const GOOGLE_SCOPES = [CONTACTS_SCOPE, "openid", "email"];

export type GoogleTokens = { accessToken: string; refreshToken: string; expiresAt: string };

/** `code` is Google's `error` value (e.g. `invalid_grant`) or one of ours. */
export class GoogleOAuthError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Google OAuth error: ${code}`);
    this.name = "GoogleOAuthError";
    this.code = code;
  }
}

export interface GoogleOAuthClient {
  buildAuthUrl(input: { clientId: string; redirectUri: string; state: string }): string;
  exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
  }): Promise<{ tokens: GoogleTokens; accountEmail: string | null }>;
  refreshAccessToken(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<{ accessToken: string; expiresAt: string }>;
  /** Revokes a refresh or access token (ends the consent at Google). */
  revokeToken(input: { token: string }): Promise<void>;
}

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});
const errorResponse = z.object({ error: z.string() });
const userinfoResponse = z.object({ email: z.string().optional() });

type OAuthInput<K extends "exchangeCode" | "revokeToken" | "refreshAccessToken"> = Parameters<
  GoogleOAuthClient[K]
>[0];

async function postToken(fetchImpl: typeof fetch, params: Record<string, string>) {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw oauthError(response, body);
  const parsed = tokenResponse.safeParse(body);
  if (!parsed.success) throw new GoogleOAuthError("invalid_token_response");
  return parsed.data;
}

function oauthError(response: Response, body: unknown): GoogleOAuthError {
  const parsed = errorResponse.safeParse(body);
  return new GoogleOAuthError(parsed.success ? parsed.data.error : `http_${response.status}`);
}

const expiresAt = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

const buildAuthUrl: GoogleOAuthClient["buildAuthUrl"] = ({ clientId, redirectUri, state }) => {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  return url.toString();
};

async function exchangeCode(
  fetchImpl: typeof fetch,
  { clientId, clientSecret, redirectUri, code }: OAuthInput<"exchangeCode">,
) {
  const token = await postToken(fetchImpl, {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });
  // Granular consent: the user may untick scopes on the consent screen.
  if (!token.scope?.split(" ").includes(CONTACTS_SCOPE)) {
    throw new GoogleOAuthError("scope_not_granted");
  }
  if (!token.refresh_token) throw new GoogleOAuthError("missing_refresh_token");
  const info = await fetchImpl(USERINFO_URL, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  const body: unknown = info.ok ? await info.json().catch(() => null) : null;
  return {
    tokens: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: expiresAt(token.expires_in),
    },
    accountEmail: userinfoResponse.safeParse(body).data?.email ?? null,
  };
}

async function revokeToken(fetchImpl: typeof fetch, { token }: OAuthInput<"revokeToken">) {
  const response = await fetchImpl(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  if (response.ok) return;
  const body: unknown = await response.json().catch(() => null);
  throw oauthError(response, body);
}

async function refreshAccessToken(
  fetchImpl: typeof fetch,
  { clientId, clientSecret, refreshToken }: OAuthInput<"refreshAccessToken">,
) {
  const token = await postToken(fetchImpl, {
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  return { accessToken: token.access_token, expiresAt: expiresAt(token.expires_in) };
}

export function createGoogleOAuthClient(fetchImpl: typeof fetch = fetch): GoogleOAuthClient {
  return {
    buildAuthUrl,
    exchangeCode: (input) => exchangeCode(fetchImpl, input),
    revokeToken: (input) => revokeToken(fetchImpl, input),
    refreshAccessToken: (input) => refreshAccessToken(fetchImpl, input),
  };
}
