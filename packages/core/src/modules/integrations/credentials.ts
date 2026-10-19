import { randomBytes } from "node:crypto";

import type { Database } from "@crm/db";

import { DomainError } from "../../errors";
import { resolveMetaConfig } from "../platform";
import type { MetaCloudCredentialsInput } from "./schemas";
import { metaCloudCredentialsSchema } from "./schemas";

/**
 * Builds the per-connection webhook URL WAHA posts to. `APP_URL` is read
 * directly like crypto.ts reads its key — @crm/config validates it at boot.
 * Undefined when the env is absent (unit tests) — the adapter then skips
 * webhook registration.
 */
export function webhookUrlFor(webhookToken: string): string | undefined {
  const base = process.env.APP_URL?.replace(/\/+$/, "");
  return base ? `${base}/api/webhooks/channels/${webhookToken}` : undefined;
}

/**
 * WAHA credentials are platform-owned: baseUrl/apiKey come from env (read
 * directly like webhookUrlFor reads APP_URL — @crm/config validates them at
 * boot). The webhook HMAC key is generated per connection and the session
 * name derives from the connection name with a random suffix — two
 * connections with the same name must never share a WAHA session or their
 * webhooks would cross-wire.
 */
export function wahaPlatformCredentials(name: string) {
  const baseUrl = process.env.WAHA_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new DomainError(
      "WAHA_NOT_CONFIGURED",
      "WhatsApp (WAHA) não está configurado nesta instância.",
    );
  }
  return {
    baseUrl,
    apiKey,
    webhookHmacKey: randomBytes(24).toString("base64url"),
    session: sessionNameFrom(name),
  };
}

/**
 * Meta app-level secrets (appSecret/verifyToken/graphApiVersion) may be
 * omitted per connection — platform_settings.meta fills the gaps. The merged
 * snapshot is validated against the strict credentials schema, so a missing
 * appSecret/verifyToken with no platform default fails here with a clear
 * error instead of a broken connection later.
 */
export async function metaCredentialsWithPlatformFallback(
  db: Database,
  input: MetaCloudCredentialsInput,
) {
  const platform = await resolveMetaConfig(db);
  const merged = {
    phoneNumberId: input.phoneNumberId,
    accessToken: input.accessToken,
    appSecret: input.appSecret ?? platform.appSecret,
    verifyToken: input.verifyToken ?? platform.verifyToken,
    graphApiVersion: input.graphApiVersion ?? platform.graphApiVersion,
  };
  const result = metaCloudCredentialsSchema.safeParse(merged);
  if (!result.success) {
    throw new DomainError(
      "META_CREDENTIALS_INCOMPLETE",
      "Credenciais Meta incompletas — informe appSecret/verifyToken na conexão ou configure o grupo Meta nas settings da plataforma.",
    );
  }
  return result.data;
}

/** URL-safe slug of the connection name + uniqueness suffix. */
function sessionNameFrom(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 55);
  return slug
    ? `${slug}-${randomBytes(4).toString("hex")}`
    : `conn_${randomBytes(8).toString("hex")}`;
}
