"use server";

import { DomainError } from "@crm/core";
import type {
  CreateDealFromConversationInput,
  CreateDealInput,
  CreateFunnelInput,
  CreateLabelInput,
  CreateStageInput,
  MoveDealInput,
  MoveStageInput,
  SetContactLabelsInput,
  SetConversationLabelsInput,
  SetDealLabelsInput,
  UpdateDealInput,
  UpdateFunnelInput,
  UpdateLabelInput,
  UpdateStageInput,
} from "@crm/core/leads";
import {
  createDeal,
  createDealFromConversation,
  createFunnel,
  createLabel,
  createStage,
  deleteDeal,
  deleteFunnel,
  deleteLabel,
  deleteStage,
  moveDeal,
  moveStage,
  searchContacts,
  setContactLabels,
  setConversationLabels,
  setDealLabels,
  updateDeal,
  updateFunnel,
  updateLabel,
  updateStage,
} from "@crm/core/leads";
import { completeStep } from "@crm/core/onboarding";
import { getDb } from "@crm/db";
import { captureException } from "@crm/observability";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireTenantContext } from "@/server/tenant";

export type LeadsActionResult<T = undefined> =
  (T extends undefined ? { ok: true } : { ok: true; data: T }) | { ok: false; error: string };

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? fallback;
  }
  if (error instanceof DomainError) {
    return error.message;
  }
  captureException(error, { action: "leads" });
  return fallback;
}

function revalidateLeads(conversationId?: string): void {
  revalidatePath("/app/deals");
  if (conversationId) revalidatePath(`/app/inbox/${conversationId}`);
}

// ---------- funnels & stages (leads:manage) ----------

export async function createFunnelAction(input: CreateFunnelInput) {
  const ctx = await requireTenantContext();
  let funnel;
  try {
    funnel = await createFunnel(getDb(), ctx, input);
  } catch (error) {
    return { ok: false as const, error: errorMessage(error, "Não foi possível criar o funil") };
  }
  try {
    await completeStep(getDb(), ctx, "create_funnel");
  } catch (checklistError) {
    captureException(checklistError, { action: "leads.checklist" });
  }
  revalidateLeads();
  return { ok: true as const, data: funnel };
}

export async function updateFunnelAction(input: UpdateFunnelInput) {
  const ctx = await requireTenantContext();
  try {
    await updateFunnel(getDb(), ctx, input);
    revalidateLeads();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error, "Não foi possível atualizar o funil") };
  }
}

export async function deleteFunnelAction(funnelId: string) {
  const ctx = await requireTenantContext();
  try {
    await deleteFunnel(getDb(), ctx, funnelId);
    revalidateLeads();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error, "Não foi possível excluir o funil") };
  }
}

export async function createStageAction(input: CreateStageInput) {
  const ctx = await requireTenantContext();
  try {
    const stage = await createStage(getDb(), ctx, input);
    revalidateLeads();
    return { ok: true as const, data: stage };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error, "Não foi possível criar a etapa") };
  }
}

export async function updateStageAction(input: UpdateStageInput) {
  const ctx = await requireTenantContext();
  try {
    await updateStage(getDb(), ctx, input);
    revalidateLeads();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error, "Não foi possível atualizar a etapa") };
  }
}

export async function moveStageAction(input: MoveStageInput) {
  const ctx = await requireTenantContext();
  try {
    await moveStage(getDb(), ctx, input);
    revalidateLeads();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error, "Não foi possível reordenar a etapa") };
  }
}

export async function deleteStageAction(stageId: string) {
  const ctx = await requireTenantContext();
  try {
    await deleteStage(getDb(), ctx, stageId);
    revalidateLeads();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error, "Não foi possível excluir a etapa") };
  }
}

// ---------- deals (leads:write / manage) ----------

export async function createDealAction(input: CreateDealInput) {
  const ctx = await requireTenantContext();
  try {
    const deal = await createDeal(getDb(), ctx, input);
    revalidateLeads();
    return { ok: true as const, data: deal };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error, "Não foi possível criar o deal") };
  }
}

export async function createDealFromConversationAction(input: CreateDealFromConversationInput) {
  const ctx = await requireTenantContext();
  try {
    const deal = await createDealFromConversation(getDb(), ctx, input);
    revalidateLeads(input.conversationId);
    return { ok: true as const, data: deal };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error, "Não foi possível criar o lead") };
  }
}

export async function updateDealAction(input: UpdateDealInput) {
  const ctx = await requireTenantContext();
  try {
    await updateDeal(getDb(), ctx, input);
    revalidateLeads();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error, "Não foi possível atualizar o deal") };
  }
}

export async function moveDealAction(input: MoveDealInput) {
  const ctx = await requireTenantContext();
  try {
    await moveDeal(getDb(), ctx, input);
    revalidateLeads();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error, "Não foi possível mover o deal") };
  }
}

export async function deleteDealAction(dealId: string, conversationId?: string) {
  const ctx = await requireTenantContext();
  try {
    await deleteDeal(getDb(), ctx, dealId);
    revalidateLeads(conversationId);
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error, "Não foi possível excluir o deal") };
  }
}

// ---------- labels ----------

export async function createLabelAction(input: CreateLabelInput) {
  const ctx = await requireTenantContext();
  try {
    const label = await createLabel(getDb(), ctx, input);
    revalidateLeads();
    return { ok: true as const, data: label };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error, "Não foi possível criar a etiqueta") };
  }
}

export async function updateLabelAction(input: UpdateLabelInput) {
  const ctx = await requireTenantContext();
  try {
    await updateLabel(getDb(), ctx, input);
    revalidateLeads();
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: errorMessage(error, "Não foi possível atualizar a etiqueta"),
    };
  }
}

export async function deleteLabelAction(labelId: string) {
  const ctx = await requireTenantContext();
  try {
    await deleteLabel(getDb(), ctx, labelId);
    revalidateLeads();
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: errorMessage(error, "Não foi possível excluir a etiqueta"),
    };
  }
}

export async function setDealLabelsAction(input: SetDealLabelsInput) {
  const ctx = await requireTenantContext();
  try {
    await setDealLabels(getDb(), ctx, input);
    revalidateLeads();
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: errorMessage(error, "Não foi possível atualizar as etiquetas"),
    };
  }
}

export async function searchContactsAction(query?: string) {
  const ctx = await requireTenantContext();
  try {
    const rows = await searchContacts(getDb(), ctx, { query });
    return { ok: true as const, data: rows };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error, "Falha ao buscar contatos"), data: [] };
  }
}

export async function setConversationLabelsAction(input: SetConversationLabelsInput) {
  const ctx = await requireTenantContext();
  try {
    await setConversationLabels(getDb(), ctx, input);
    revalidateLeads(input.conversationId);
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: errorMessage(error, "Não foi possível atualizar as etiquetas"),
    };
  }
}

/** Tags do contato (E2) — replace semantics, same leads:write gate. */
export async function setContactLabelsAction(input: SetContactLabelsInput) {
  const ctx = await requireTenantContext();
  try {
    await setContactLabels(getDb(), ctx, input);
    revalidatePath("/app/inbox");
    revalidatePath("/app/contacts");
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: errorMessage(error, "Não foi possível atualizar as tags"),
    };
  }
}
