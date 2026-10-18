import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

let envFileLoaded = false;

/**
 * Loads the repository root `.env` into process.env (single env source for the
 * whole monorepo). Next.js additionally loads it via `loadEnvConfig` in
 * apps/web/next.config.ts. Safe to call multiple times.
 */
export function loadRootEnv(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const envPath = resolve(rootDir, ".env");
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    throw new Error(`Failed to load ${envPath}`, { cause: error });
  }
}

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === "" || value === undefined ? undefined : value));

// Optional, but when present must be exactly 32 bytes as hex (AES-256 key).
const optionalHex64 = optionalString.refine(
  (value) => value === undefined || /^[0-9a-f]{64}$/i.test(value),
  "must be 64 hex characters (32 bytes); generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  APP_URL: z.url(),

  DATABASE_URL: z.string().min(1),
  DATABASE_ADMIN_URL: optionalString,
  REDIS_URL: optionalString,

  BETTER_AUTH_SECRET: z.string().min(32),
  // Optional overrides — both default to on in production. The standalone
  // server hardcodes NODE_ENV=production, so e2e needs explicit opt-outs.
  AUTH_REQUIRE_EMAIL_VERIFICATION: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  AUTH_RATE_LIMIT: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),

  OPENAI_API_KEY: optionalString,
  ANTHROPIC_API_KEY: optionalString,

  WAHA_BASE_URL: optionalString,
  WAHA_API_KEY: optionalString,
  WAHA_WEBHOOK_HMAC_KEY: optionalString,

  META_APP_SECRET: optionalString,
  META_VERIFY_TOKEN: optionalString,
  META_ACCESS_TOKEN: optionalString,
  META_PHONE_NUMBER_ID: optionalString,
  META_GRAPH_API_VERSION: z.string().default("v26.0"),

  CHANNEL_CREDENTIALS_KEY: optionalHex64,

  STORAGE_S3_ENDPOINT: optionalString,
  STORAGE_S3_REGION: optionalString,
  STORAGE_S3_BUCKET: optionalString,
  STORAGE_S3_ACCESS_KEY_ID: optionalString,
  STORAGE_S3_SECRET_ACCESS_KEY: optionalString,
  STORAGE_S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),

  ASAAS_API_KEY: optionalString,
  ASAAS_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  ASAAS_WEBHOOK_TOKEN: optionalString,

  EMAIL_PROVIDER: z.enum(["console", "resend", "smtp"]).default("console"),
  EMAIL_FROM: optionalString,
  RESEND_API_KEY: optionalString,
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_SECURE: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),

  SENTRY_DSN: optionalString,
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalString,
  OTEL_SERVICE_NAME: optionalString,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

type RawEnv = z.output<typeof envSchema>;

const coreEnv = (env: RawEnv) => ({
  nodeEnv: env.NODE_ENV,
  appUrl: env.APP_URL,
  logLevel: env.LOG_LEVEL,
  database: {
    url: env.DATABASE_URL,
    adminUrl: env.DATABASE_ADMIN_URL,
  },
  redis: { url: env.REDIS_URL },
  auth: {
    secret: env.BETTER_AUTH_SECRET,
    requireEmailVerification: env.AUTH_REQUIRE_EMAIL_VERIFICATION ?? env.NODE_ENV === "production",
    rateLimit: env.AUTH_RATE_LIMIT ?? env.NODE_ENV === "production",
  },
  ai: {
    openaiApiKey: env.OPENAI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
  },
});

const providersEnv = (env: RawEnv) => ({
  whatsapp: {
    waha: {
      baseUrl: env.WAHA_BASE_URL,
      apiKey: env.WAHA_API_KEY,
      webhookHmacKey: env.WAHA_WEBHOOK_HMAC_KEY,
    },
    meta: {
      appSecret: env.META_APP_SECRET,
      verifyToken: env.META_VERIFY_TOKEN,
      accessToken: env.META_ACCESS_TOKEN,
      phoneNumberId: env.META_PHONE_NUMBER_ID,
      graphApiVersion: env.META_GRAPH_API_VERSION,
    },
  },
  channels: {
    credentialsKey: env.CHANNEL_CREDENTIALS_KEY,
  },
  storage: {
    endpoint: env.STORAGE_S3_ENDPOINT,
    region: env.STORAGE_S3_REGION,
    bucket: env.STORAGE_S3_BUCKET,
    accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
  },
});

const servicesEnv = (env: RawEnv) => ({
  billing: {
    asaasApiKey: env.ASAAS_API_KEY,
    asaasEnvironment: env.ASAAS_ENVIRONMENT,
    asaasWebhookToken: env.ASAAS_WEBHOOK_TOKEN,
  },
  email: {
    provider: env.EMAIL_PROVIDER,
    from: env.EMAIL_FROM,
    resendApiKey: env.RESEND_API_KEY,
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      secure: env.SMTP_SECURE,
    },
  },
  observability: {
    sentryDsn: env.SENTRY_DSN,
    otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelServiceName: env.OTEL_SERVICE_NAME,
  },
});

const serverEnvSchema = envSchema.transform((env) => ({
  ...coreEnv(env),
  ...providersEnv(env),
  ...servicesEnv(env),
}));

export type ServerEnv = z.output<typeof serverEnvSchema>;

/**
 * Whether all required settings of an integration group are present.
 * Groups the app boots without; use these before touching an integration.
 */
const integrationPredicates: Record<IntegrationGroup, (env: ServerEnv) => boolean> = {
  ai: (env) => Boolean(env.ai.openaiApiKey ?? env.ai.anthropicApiKey),
  waha: (env) => Boolean(env.whatsapp.waha.baseUrl && env.whatsapp.waha.apiKey),
  meta: (env) =>
    Boolean(
      env.whatsapp.meta.appSecret &&
      env.whatsapp.meta.verifyToken &&
      env.whatsapp.meta.accessToken &&
      env.whatsapp.meta.phoneNumberId,
    ),
  storage: (env) =>
    Boolean(
      env.storage.endpoint &&
      env.storage.bucket &&
      env.storage.accessKeyId &&
      env.storage.secretAccessKey,
    ),
  billing: (env) => Boolean(env.billing.asaasApiKey),
  resend: (env) => env.email.provider === "resend" && Boolean(env.email.resendApiKey),
  smtp: (env) => env.email.provider === "smtp" && Boolean(env.email.smtp.host),
  redis: (env) => Boolean(env.redis.url),
  sentry: (env) => Boolean(env.observability.sentryDsn),
  otel: (env) => Boolean(env.observability.otelEndpoint),
};

export function isConfigured(env: ServerEnv, group: IntegrationGroup): boolean {
  return integrationPredicates[group](env);
}

export type IntegrationGroup =
  "ai" | "waha" | "meta" | "storage" | "billing" | "resend" | "smtp" | "redis" | "sentry" | "otel";

let cached: ServerEnv | undefined;

/**
 * Parses process.env (after loading the root .env) once and caches the result.
 * Throws an error listing every invalid variable — the app must boot with only
 * the required vars set.
 */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  loadRootEnv();
  const result = serverEnvSchema.safeParse(process.env);
  if (!result.success) {
    const details = z.prettifyError(result.error);
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  cached = result.data;
  return cached;
}

/** Test hook: clears the cached env so a new process.env can be parsed. */
export function resetServerEnvCache(): void {
  cached = undefined;
}
