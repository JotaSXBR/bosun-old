import type { createDb } from "@crm/db";

export type SeedDb = ReturnType<typeof createDb>;
export type IdMap = ReadonlyMap<string, string>;

export function ts(daysAgo: number, hour = 10, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d;
}
