"use server";

import { DomainError } from "@crm/core";
import { platformSettingGroupSchema, setPlatformSetting } from "@crm/core/platform";
import { getDb } from "@crm/db";
import { captureException } from "@crm/observability";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireTenantContext } from "@/server/tenant";

export type PlatformActionResult = { ok: true } | { ok: false; error: string };

const inputSchema = z.object({
  group: platformSettingGroupSchema,
  values: z.record(z.string(), z.unknown()),
});

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? fallback;
  }
  if (error instanceof DomainError) {
    return error.message;
  }
  captureException(error, { action: "platform-settings" });
  return fallback;
}

/**
 * Saves one product-settings group (platform_admin only, enforced in the
 * service). Secrets are write-only: blank fields preserve stored values.
 */
export async function updatePlatformSettingAction(input: {
  group: string;
  values: Record<string, unknown>;
}): Promise<PlatformActionResult> {
  const ctx = await requireTenantContext();
  try {
    const parsed = inputSchema.parse(input);
    await setPlatformSetting(getDb(), ctx, { group: parsed.group, input: parsed.values });
    revalidatePath("/app/platform");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível salvar a configuração.") };
  }
}
