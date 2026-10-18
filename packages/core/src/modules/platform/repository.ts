import type { Transaction } from "@crm/db";
import { schema } from "@crm/db";
import { inArray } from "drizzle-orm";

const { platformSettings } = schema;

export type PlatformSettingRow = typeof platformSettings.$inferSelect;

/** Call only inside a platform-scope transaction — RLS denies anything else. */
export async function listPlatformSettingRows(tx: Transaction): Promise<PlatformSettingRow[]> {
  return tx.select().from(platformSettings);
}

export async function upsertPlatformSettingRow(
  tx: Transaction,
  key: string,
  { valueEncrypted, updatedByUserId }: { valueEncrypted: string; updatedByUserId: string },
): Promise<void> {
  await tx
    .insert(platformSettings)
    .values({ key, valueEncrypted, updatedByUserId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { valueEncrypted, updatedByUserId, updatedAt: new Date() },
    });
}

export async function deletePlatformSettingRows(tx: Transaction, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await tx.delete(platformSettings).where(inArray(platformSettings.key, keys));
}
