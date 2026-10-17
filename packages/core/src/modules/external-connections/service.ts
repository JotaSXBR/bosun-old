import { randomBytes, timingSafeEqual } from "node:crypto";

import type { Database } from "@crm/db";
import { withTenant } from "@crm/db";
import { captureException } from "@crm/observability";

import { DomainError, NotFoundError } from "../../errors";
import { decryptJson, encryptJson } from "../../lib/crypto";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import type { GoogleOAuthClient } from "./google-oauth";
import { createGoogleOAuthClient, GoogleOAuthError } from "./google-oauth";
import type { ExternalConnectionPublic, ExternalConnectionRow } from "./repository";
import {
  deleteConnection,
  findConnection,
  toPublic,
  updateConnection,
  upsertConnection,
} from "./repository";
import type {
  CompleteGoogleAuthorizationInput,
  GoogleBundle,
  SaveGoogleClientInput,
} from "./schemas";
import {
  completeGoogleAuthorizationInput,
  googleBundleSchema,
  saveGoogleClientInput,
} from "./schemas";

const PROVIDER = "google";
const STATE_TTL_MS = 10 * 60 * 1000;

const openBundle = (row: ExternalConnectionRow): GoogleBundle =>
  googleBundleSchema.parse(decryptJson(row.bundleEncrypted));

function stateMatches(bundle: GoogleBundle, state: string): boolean {
  if (!bundle.state || Date.now() - bundle.state.issuedAt > STATE_TTL_MS) return false;
  const expected = Buffer.from(bundle.state.nonce);
  const given = Buffer.from(state);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Requires integrations:manage. Stores the org's own OAuth client (BYOK),
 * opens a fresh consent attempt (`pending`) and returns the Google URL to
 * send the user to. Re-saving replaces any previous connection state.
 */
export async function saveGoogleClient(
  db: Database,
  ctx: TenantContext,
  input: SaveGoogleClientInput,
  oauth: GoogleOAuthClient = createGoogleOAuthClient(),
): Promise<{ authUrl: string }> {
  assertPermission(ctx, { integrations: ["manage"] });
  const parsed = saveGoogleClientInput.parse(input);
  const nonce = randomBytes(24).toString("base64url");
  const bundle: GoogleBundle = {
    clientId: parsed.clientId,
    clientSecret: parsed.clientSecret,
    state: { nonce, issuedAt: Date.now() },
  };
  await withTenant(db, ctx.organizationId, (tx) =>
    upsertConnection(tx, {
      organizationId: ctx.organizationId,
      provider: PROVIDER,
      status: "pending",
      bundleEncrypted: encryptJson(bundle),
    }),
  );
  return {
    authUrl: oauth.buildAuthUrl({
      clientId: parsed.clientId,
      redirectUri: parsed.redirectUri,
      state: nonce,
    }),
  };
}

/**
 * Requires integrations:manage. Finishes the consent: the `state` must match
 * the pending attempt (single-use, 10 min). A failed exchange parks the
 * connection in `error` — the user starts over with a new consent.
 */
export async function completeGoogleAuthorization(
  db: Database,
  ctx: TenantContext,
  input: CompleteGoogleAuthorizationInput,
  oauth: GoogleOAuthClient = createGoogleOAuthClient(),
): Promise<ExternalConnectionPublic> {
  assertPermission(ctx, { integrations: ["manage"] });
  const parsed = completeGoogleAuthorizationInput.parse(input);

  const pending = await withTenant(db, ctx.organizationId, async (tx) => {
    const row = await findConnection(tx, ctx.organizationId, PROVIDER);
    if (row?.status !== "pending") return null;
    const bundle = openBundle(row);
    return stateMatches(bundle, parsed.state) ? { id: row.id, bundle } : null;
  });
  if (!pending) {
    throw new DomainError(
      "GOOGLE_STATE_INVALID",
      "Autorização expirada ou inválida. Conecte de novo.",
    );
  }

  const { state: _consumed, ...client } = pending.bundle;
  try {
    const { tokens, accountEmail } = await oauth.exchangeCode({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: parsed.redirectUri,
      code: parsed.code,
    });
    return await withTenant(db, ctx.organizationId, async (tx) => {
      const row = await updateConnection(tx, pending.id, {
        status: "connected",
        bundleEncrypted: encryptJson({ ...client, tokens }),
        accountEmail,
        lastCheckedAt: new Date(),
        lastError: null,
      });
      if (!row) throw new NotFoundError("ExternalConnection", pending.id);
      return toPublic(row);
    });
  } catch (error) {
    if (!(error instanceof GoogleOAuthError)) throw error;
    await withTenant(db, ctx.organizationId, (tx) =>
      updateConnection(tx, pending.id, {
        status: "error",
        bundleEncrypted: encryptJson(client),
        lastError: error.code,
      }),
    );
    throw new DomainError("GOOGLE_AUTH_FAILED", "O Google recusou a autorização. Tente de novo.");
  }
}

/**
 * Requires integrations:manage. Re-checks the token live by refreshing it.
 * `invalid_grant` (revoked/expired consent) → `needs_reauth`; any other
 * failure → `error`. Returns the resulting status rather than throwing.
 */
export async function verifyGoogleConnection(
  db: Database,
  ctx: TenantContext,
  oauth: GoogleOAuthClient = createGoogleOAuthClient(),
): Promise<ExternalConnectionPublic> {
  assertPermission(ctx, { integrations: ["manage"] });
  const row = await withTenant(db, ctx.organizationId, (tx) =>
    findConnection(tx, ctx.organizationId, PROVIDER),
  );
  const bundle = row ? openBundle(row) : null;
  if (!row?.id || !bundle?.tokens) {
    throw new DomainError("GOOGLE_NOT_CONNECTED", "Nenhuma conta Google conectada.");
  }

  let update: Parameters<typeof updateConnection>[2];
  try {
    const refreshed = await oauth.refreshAccessToken({
      clientId: bundle.clientId,
      clientSecret: bundle.clientSecret,
      refreshToken: bundle.tokens.refreshToken,
    });
    update = {
      status: "connected",
      bundleEncrypted: encryptJson({ ...bundle, tokens: { ...bundle.tokens, ...refreshed } }),
      lastCheckedAt: new Date(),
      lastError: null,
    };
  } catch (error) {
    if (!(error instanceof GoogleOAuthError)) throw error;
    update = {
      status: error.code === "invalid_grant" ? "needs_reauth" : "error",
      lastCheckedAt: new Date(),
      lastError: error.code,
    };
  }
  return withTenant(db, ctx.organizationId, async (tx) => {
    const updated = await updateConnection(tx, row.id, update);
    if (!updated) throw new NotFoundError("ExternalConnection", row.id);
    return toPublic(updated);
  });
}

const TOKEN_MARGIN_MS = 60_000;

async function renewAccessToken(
  db: Database,
  row: ExternalConnectionRow,
  oauth: GoogleOAuthClient,
): Promise<{ accessToken: string } | null> {
  const bundle = openBundle(row);
  const tokens = bundle.tokens;
  if (!tokens) return null;
  try {
    const refreshed = await oauth.refreshAccessToken({
      clientId: bundle.clientId,
      clientSecret: bundle.clientSecret,
      refreshToken: tokens.refreshToken,
    });
    await withTenant(db, row.organizationId, (tx) =>
      updateConnection(tx, row.id, {
        bundleEncrypted: encryptJson({ ...bundle, tokens: { ...tokens, ...refreshed } }),
        lastCheckedAt: new Date(),
        lastError: null,
      }),
    );
    return { accessToken: refreshed.accessToken };
  } catch (error) {
    if (!(error instanceof GoogleOAuthError) || error.code !== "invalid_grant") throw error;
    await withTenant(db, row.organizationId, (tx) =>
      updateConnection(tx, row.id, {
        status: "needs_reauth",
        lastCheckedAt: new Date(),
        lastError: error.code,
      }),
    );
    return null;
  }
}

/**
 * Internal — trusted system path (the contact sync job), no role check. A
 * usable access token for the org's connected Google account, renewed and
 * persisted when it is (about to be) expired. `invalid_grant` marks the
 * connection `needs_reauth` and returns null, as does a missing or not
 * `connected` account; any other refresh failure rethrows and leaves the
 * connection untouched.
 */
export async function getGoogleAccessToken(
  db: Database,
  organizationId: string,
  oauth: GoogleOAuthClient = createGoogleOAuthClient(),
): Promise<{ accessToken: string } | null> {
  const row = await withTenant(db, organizationId, (tx) =>
    findConnection(tx, organizationId, PROVIDER),
  );
  if (row?.status !== "connected") return null;
  const tokens = openBundle(row).tokens;
  if (!tokens) return null;
  if (Date.parse(tokens.expiresAt) - Date.now() > TOKEN_MARGIN_MS) {
    return { accessToken: tokens.accessToken };
  }
  return renewAccessToken(db, row, oauth);
}

/**
 * Internal — trusted system path. Google rejected a valid-looking token
 * (revoked consent or scope): flag the connection so the UI asks to reconnect
 * instead of every contact failing silently.
 */
export async function markGoogleNeedsReauth(
  db: Database,
  organizationId: string,
  lastError: string,
): Promise<void> {
  await withTenant(db, organizationId, async (tx) => {
    const row = await findConnection(tx, organizationId, PROVIDER);
    if (row?.status !== "connected") return;
    await updateConnection(tx, row.id, {
      status: "needs_reauth",
      lastCheckedAt: new Date(),
      lastError,
    });
  });
}

/**
 * Requires integrations:manage. Removes the connection, then revokes the
 * refresh token at Google (best effort: a failed revoke never blocks the
 * local disconnect). Contacts already pushed stay in the Google account.
 */
export async function disconnectGoogle(
  db: Database,
  ctx: TenantContext,
  oauth: GoogleOAuthClient = createGoogleOAuthClient(),
): Promise<void> {
  assertPermission(ctx, { integrations: ["manage"] });
  const refreshToken = await withTenant(db, ctx.organizationId, async (tx) => {
    const row = await findConnection(tx, ctx.organizationId, PROVIDER);
    if (!row) throw new NotFoundError("ExternalConnection");
    const token = openBundle(row).tokens?.refreshToken;
    await deleteConnection(tx, row.id);
    return token;
  });
  if (!refreshToken) return;
  try {
    await oauth.revokeToken({ token: refreshToken });
  } catch (error) {
    captureException(error, { module: "external-connections", op: "google-revoke" });
  }
}

/** Requires integrations:read. Secret material is never returned. */
export async function getGoogleStatus(
  db: Database,
  ctx: TenantContext,
): Promise<ExternalConnectionPublic | null> {
  assertPermission(ctx, { integrations: ["read"] });
  const row = await withTenant(db, ctx.organizationId, (tx) =>
    findConnection(tx, ctx.organizationId, PROVIDER),
  );
  return row ? toPublic(row) : null;
}
