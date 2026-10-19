import type { ServerEnv } from "@crm/config";
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { withPlatformScope, withServiceAccess } from "@crm/db";

import { AuthorizationError } from "../../errors";
import { decryptJson, encryptJson } from "../../lib/crypto";
import type { TenantContext } from "../../tenant/context";
import type { PlatformSettingRow } from "./repository";
import { listPlatformSettingRows, upsertPlatformSettingRow } from "./repository";
import type { PlatformSettingGroup } from "./schemas";
import {
  platformSecretFields,
  platformSettingGroupSchema,
  platformSettingValueSchemas,
} from "./schemas";

/**
 * Product settings resolved DB → env. Same shapes as the matching ServerEnv
 * slices, so consumers trade `env.email` for `settings.email` unchanged.
 */
export type ProductSettings = {
  email: ServerEnv["email"];
  billing: ServerEnv["billing"];
  meta: ServerEnv["whatsapp"]["meta"];
  ai: ServerEnv["ai"];
};

function mergeDefined<T extends object>(base: T, override: object): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

type StoredSettings = Partial<Record<PlatformSettingGroup, Record<string, unknown>>>;

/** The row's group and decrypted value; null for unknown groups, wrong key/corruption or invalid shape. */
function readStoredRow(
  row: PlatformSettingRow,
): { group: PlatformSettingGroup; value: Record<string, unknown> } | null {
  const group = platformSettingGroupSchema.safeParse(row.key);
  if (!group.success) return null;
  let decrypted: unknown;
  try {
    decrypted = decryptJson(row.valueEncrypted);
  } catch {
    return null; // wrong key or corruption — env fallback still applies
  }
  const parsed = platformSettingValueSchemas[group.data].safeParse(decrypted);
  return parsed.success ? { group: group.data, value: parsed.data } : null;
}

async function readStoredSettings(
  db: Database,
): Promise<{ stored: StoredSettings; rows: PlatformSettingRow[] }> {
  const rows = await withServiceAccess(db, (tx) => listPlatformSettingRows(tx));
  const stored: StoredSettings = {};
  for (const row of rows) {
    const entry = readStoredRow(row);
    if (entry) stored[entry.group] = entry.value;
  }
  return { stored, rows };
}

function resolveEmail(
  env: ServerEnv["email"],
  stored?: Record<string, unknown>,
): ServerEnv["email"] {
  const merged = mergeDefined(env, stored ?? {});
  const smtpStored = stored?.smtp;
  if (smtpStored && typeof smtpStored === "object") {
    merged.smtp = mergeDefined(env.smtp, smtpStored);
  }
  return merged;
}

function resolveFrom(env: ServerEnv, stored: StoredSettings): ProductSettings {
  return {
    email: resolveEmail(env.email, stored.email),
    billing: mergeDefined(env.billing, stored.billing ?? {}),
    meta: mergeDefined(env.whatsapp.meta, stored.meta ?? {}),
    ai: mergeDefined(env.ai, stored.ai ?? {}),
  };
}

/**
 * Resolves the product settings: every field falls back to env when the DB
 * row/group is absent, so env-only installs keep working. Reads run under
 * service access — safe to call from unauthenticated paths (webhooks, mail
 * dispatch) after the caller has verified the request some other way.
 */
export async function resolveProductSettings(db: Database): Promise<ProductSettings> {
  const { stored } = await readStoredSettings(db);
  return resolveFrom(getServerEnv(), stored);
}

export async function resolveEmailConfig(db: Database): Promise<ServerEnv["email"]> {
  return (await resolveProductSettings(db)).email;
}

export async function resolveBillingConfig(db: Database): Promise<ServerEnv["billing"]> {
  return (await resolveProductSettings(db)).billing;
}

export async function resolveMetaConfig(db: Database): Promise<ServerEnv["whatsapp"]["meta"]> {
  return (await resolveProductSettings(db)).meta;
}

function configuredFor(
  group: PlatformSettingGroup,
  settings: ProductSettings,
  hasRow: boolean,
): boolean {
  switch (group) {
    case "email":
      // console: only "configured" once chosen explicitly — that's what makes
      // a fresh install (env default console, no row) trigger the setup wizard.
      if (settings.email.provider === "resend") return Boolean(settings.email.resendApiKey);
      if (settings.email.provider === "smtp") return Boolean(settings.email.smtp.host);
      return hasRow;
    case "billing":
      return Boolean(settings.billing.asaasApiKey);
    case "meta":
      return Boolean(
        settings.meta.appSecret &&
        settings.meta.verifyToken &&
        settings.meta.accessToken &&
        settings.meta.phoneNumberId,
      );
    case "ai":
      return Boolean(settings.ai.openaiApiKey ?? settings.ai.anthropicApiKey);
  }
}

/**
 * Whether a group is ready to use after DB→env resolution. `email` treats a
 * stored row as an explicit choice — an install whose only config is the env
 * default `console` counts as *not* configured (that's the setup-wizard
 * trigger), while an admin who saved `console` deliberately is done.
 */
export async function isProductConfigured(
  db: Database,
  group: PlatformSettingGroup,
): Promise<boolean> {
  const { stored, rows } = await readStoredSettings(db);
  return configuredFor(
    group,
    resolveFrom(getServerEnv(), stored),
    rows.some((r) => r.key === group),
  );
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
      obj,
    );
}

function redactGroup(
  group: PlatformSettingGroup,
  resolved: Record<string, unknown>,
): { values: Record<string, unknown>; secretsSet: Record<string, boolean> } {
  const values = structuredClone(resolved);
  const secretsSet: Record<string, boolean> = {};
  for (const path of platformSecretFields[group]) {
    secretsSet[path] = Boolean(getPath(resolved, path));
    const parts = path.split(".");
    const leaf = parts.pop()!;
    const parent = parts.reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
      values,
    );
    if (parent && typeof parent === "object") {
      delete (parent as Record<string, unknown>)[leaf];
    }
  }
  return { values, secretsSet };
}

export type PlatformSettingSummary = {
  group: PlatformSettingGroup;
  /** Ready-to-use after DB→env resolution (same predicates as isProductConfigured). */
  configured: boolean;
  /** Non-secret resolved fields (DB value > env > unset) — safe to render. */
  values: Record<string, unknown>;
  /** Secret field path → whether any value is set (env or DB). Never the value. */
  secretsSet: Record<string, boolean>;
  /** Dot-paths of the fields the DB row overrides (helps the UI show "em DB"). */
  dbFields: string[];
  updatedAt: Date | null;
};

/** Dot-paths of the leaf fields set in a stored group. */
function dbFieldPaths(obj: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (value && typeof value === "object") {
      paths.push(...dbFieldPaths(value as Record<string, unknown>, `${prefix}${key}.`));
    } else {
      paths.push(`${prefix}${key}`);
    }
  }
  return paths;
}

/** Platform-admin-only read view. Secrets are redacted to presence flags. */
export async function listPlatformSettingSummaries(
  db: Database,
  ctx: TenantContext,
): Promise<PlatformSettingSummary[]> {
  if (!ctx.isPlatformAdmin) throw new AuthorizationError();
  const { stored, rows } = await readStoredSettings(db);
  const settings = resolveFrom(getServerEnv(), stored);
  const byKey = new Map<string, PlatformSettingRow>(rows.map((r) => [r.key, r]));
  return platformSettingGroupSchema.options.map((group) => {
    const row = byKey.get(group);
    return {
      group,
      configured: configuredFor(group, settings, row !== undefined),
      ...redactGroup(group, settings[group]),
      dbFields: dbFieldPaths(stored[group] ?? {}),
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

function unsetPath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  const leaf = parts.pop()!;
  const parent = parts.reduce<unknown>(
    (acc, key) =>
      acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
    obj,
  );
  if (parent && typeof parent === "object") {
    delete (parent as Record<string, unknown>)[leaf];
  }
}

/**
 * Splits incoming values into schema-ready values + the non-secret paths the
 * caller cleared. Blank *secrets* are skipped (write-only — preserve the
 * stored value); blank *non-secret* fields are explicit clears — the stored
 * override is deleted and the field falls back to env.
 */
function splitInput(
  group: PlatformSettingGroup,
  input: Record<string, unknown>,
): { values: Record<string, unknown>; cleared: Set<string> } {
  const secrets = new Set(platformSecretFields[group]);
  const values: Record<string, unknown> = {};
  const cleared = new Set<string>();
  const walk = (obj: Record<string, unknown>, prefix: string, out: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(obj)) {
      const path = `${prefix}${key}`;
      if (value === "") {
        if (!secrets.has(path)) cleared.add(path);
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const nested: Record<string, unknown> = {};
        walk(value as Record<string, unknown>, `${path}.`, nested);
        out[key] = nested;
      } else {
        out[key] = value;
      }
    }
  };
  walk(input, "", values);
  return { values, cleared };
}

/** Field-level merge; the nested `smtp` object merges per field too. */
function mergeStoredWithInput(
  existing: Record<string, unknown>,
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = mergeDefined(existing, parsed);
  const existingSmtp = existing.smtp;
  const parsedSmtp = parsed.smtp;
  if (
    existingSmtp &&
    typeof existingSmtp === "object" &&
    parsedSmtp &&
    typeof parsedSmtp === "object"
  ) {
    merged.smtp = mergeDefined(existingSmtp, parsedSmtp);
  }
  return merged;
}

/**
 * Stores one settings group (platform admins only). Field-level merge over
 * the stored row: absent keys preserve the stored value, blank secrets are
 * preserved (write-only), blank non-secrets clear the override back to env.
 * Read-modify-write is non-atomic — concurrent admin saves are
 * last-write-wins per field (acceptable for settings). `updatedByUserId`
 * records who changed it; platform settings are deliberately outside the
 * tenant-scoped audit log.
 */
export async function setPlatformSetting(
  db: Database,
  ctx: TenantContext,
  { group, input }: { group: PlatformSettingGroup; input: Record<string, unknown> },
): Promise<void> {
  if (!ctx.isPlatformAdmin) throw new AuthorizationError();
  const { values, cleared } = splitInput(group, input);
  const parsed: Record<string, unknown> = platformSettingValueSchemas[group].parse(values);
  const { stored } = await readStoredSettings(db);
  const existing = structuredClone(stored[group] ?? {});
  for (const path of cleared) unsetPath(existing, path);
  const valueEncrypted = encryptJson(mergeStoredWithInput(existing, parsed));
  await withPlatformScope(db, (tx) =>
    upsertPlatformSettingRow(tx, group, { valueEncrypted, updatedByUserId: ctx.userId }),
  );
}
