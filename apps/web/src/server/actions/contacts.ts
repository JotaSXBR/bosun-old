"use server";

import { enqueueContactGoogleSync } from "@crm/automation";
import { DomainError } from "@crm/core";
import type { CreateContactInput, UpdateContactProfileInput } from "@crm/core/contacts";
import { createContact, updateContactProfile } from "@crm/core/contacts";
import { isGoogleAutoSyncActive } from "@crm/core/external-connections";
import type { StartOutboundConversationInput } from "@crm/core/messaging";
import { startOutboundConversation } from "@crm/core/messaging";
import { getDb } from "@crm/db";
import { captureException } from "@crm/observability";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireTenantContext } from "@/server/tenant";

export type ContactsActionResult = { ok: true; id: string } | { ok: false; error: string };

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? fallback;
  }
  if (error instanceof DomainError) {
    return error.message;
  }
  captureException(error, { action: "contacts" });
  return fallback;
}

/** Best effort: the edit already succeeded, the periodic sweep covers a missed enqueue. */
async function queueGoogleSync(organizationId: string, contactId: string): Promise<void> {
  try {
    if (await isGoogleAutoSyncActive(getDb(), organizationId)) {
      await enqueueContactGoogleSync({ organizationId, contactId });
    }
  } catch (error) {
    captureException(error, { action: "contacts", op: "google-sync-enqueue" });
  }
}

export async function createContactAction(
  input: CreateContactInput,
): Promise<ContactsActionResult> {
  const ctx = await requireTenantContext();
  try {
    const contact = await createContact(getDb(), ctx, input);
    await queueGoogleSync(ctx.organizationId, contact.id);
    revalidatePath("/app/contacts");
    return { ok: true, id: contact.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível criar o contato.") };
  }
}

/** Ficha edit — name + profile fields in metadata, local only (no channel sync). */
export async function updateContactProfileAction(
  input: UpdateContactProfileInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireTenantContext();
  try {
    const contact = await updateContactProfile(getDb(), ctx, input);
    await queueGoogleSync(ctx.organizationId, contact.id);
    revalidatePath("/app/inbox");
    revalidatePath("/app/contacts");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível atualizar o contato.") };
  }
}

export async function startOutboundConversationAction(
  input: StartOutboundConversationInput,
): Promise<ContactsActionResult> {
  const ctx = await requireTenantContext();
  try {
    const { conversation } = await startOutboundConversation(getDb(), ctx, input);
    revalidatePath("/app/inbox");
    revalidatePath("/app/contacts");
    return { ok: true, id: conversation.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Não foi possível abrir a conversa.") };
  }
}
