"use server";

import type { TenantContext } from "@crm/core";
import { DomainError } from "@crm/core";
import { isProductConfigured, setPlatformSetting } from "@crm/core/platform";
import { getDb } from "@crm/db";
import { captureException } from "@crm/observability";
import { z } from "zod";

import { requireSession } from "@/server/tenant";

export type SetupActionResult = { ok: true } | { ok: false; error: string };

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? fallback;
  }
  if (error instanceof DomainError) {
    return error.message;
  }
  captureException(error, { action: "setup" });
  return fallback;
}

/**
 * First-run wizard save — must not go through requireTenantContext (that
 * helper is what redirects here). Builds a platform-only context from the
 * session; the service still enforces isPlatformAdmin.
 */
export async function saveSetupEmailAction(
  values: Record<string, unknown>,
): Promise<SetupActionResult> {
  const session = await requireSession();
  const ctx: TenantContext = {
    organizationId: session.session.activeOrganizationId ?? "",
    userId: session.user.id,
    role: "owner",
    isPlatformAdmin: session.user.role === "platform_admin",
  };
  const db = getDb();
  try {
    await setPlatformSetting(db, ctx, { group: "email", input: values });
    if (!(await isProductConfigured(db, "email"))) {
      return {
        ok: false,
        error: "Configuração incompleta — verifique os campos do provider escolhido.",
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível salvar.") };
  }
}
