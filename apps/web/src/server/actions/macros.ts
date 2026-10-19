"use server";

import { DomainError } from "@crm/core";
import type { CreateMacroInput, UpdateMacroInput } from "@crm/core/macros";
import {
  approveMacroSuggestion,
  createMacro,
  deleteMacro,
  rejectMacroSuggestion,
  updateMacro,
} from "@crm/core/macros";
import { proposeMacroEntry } from "@crm/core/suggestions";
import { getDb } from "@crm/db";
import { captureException } from "@crm/observability";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireTenantContext } from "@/server/tenant";

export type MacroActionResult = { ok: true } | { ok: false; error: string };

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? fallback;
  }
  if (error instanceof DomainError) {
    return error.message;
  }
  captureException(error, { action: "macros" });
  return fallback;
}

function revalidateMacros(): void {
  revalidatePath("/app/settings/service/macros");
}

export async function createMacroAction(input: CreateMacroInput): Promise<MacroActionResult> {
  const ctx = await requireTenantContext();
  try {
    await createMacro(getDb(), ctx, input);
    revalidateMacros();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível criar a macro.") };
  }
}

export async function updateMacroAction(
  macroId: string,
  input: UpdateMacroInput,
): Promise<MacroActionResult> {
  const ctx = await requireTenantContext();
  try {
    await updateMacro(getDb(), ctx, { macroId, input });
    revalidateMacros();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível atualizar a macro.") };
  }
}

export async function deleteMacroAction(macroId: string): Promise<MacroActionResult> {
  const ctx = await requireTenantContext();
  try {
    await deleteMacro(getDb(), ctx, macroId);
    revalidateMacros();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível excluir a macro.") };
  }
}

/** Agent path — a proposal, not a direct write. */
export async function proposeMacroAction(input: unknown): Promise<MacroActionResult> {
  const ctx = await requireTenantContext();
  try {
    await proposeMacroEntry(getDb(), ctx, input);
    revalidateMacros();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível propor a macro.") };
  }
}

export async function approveMacroAction(suggestionId: string): Promise<MacroActionResult> {
  const ctx = await requireTenantContext();
  try {
    await approveMacroSuggestion(getDb(), ctx, suggestionId);
    revalidateMacros();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível aprovar a macro.") };
  }
}

export async function rejectMacroAction(suggestionId: string): Promise<MacroActionResult> {
  const ctx = await requireTenantContext();
  try {
    await rejectMacroSuggestion(getDb(), ctx, suggestionId);
    revalidateMacros();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível rejeitar a macro.") };
  }
}
