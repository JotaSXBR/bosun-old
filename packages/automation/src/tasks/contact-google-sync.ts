import { syncContactToGoogle } from "@crm/core/external-connections";
import { getDb } from "@crm/db";
import { captureException } from "@crm/observability";
import { z } from "zod";

export const contactGoogleSyncPayload = z.object({
  organizationId: z.uuid(),
  contactId: z.uuid(),
});

export type ContactGoogleSyncPayload = z.infer<typeof contactGoogleSyncPayload>;

/**
 * Mirrors one contact into the org's Google account. Always completes: the
 * queue is `key_strict_fifo`, so a failed job would hold the whole org's
 * key (a `failed` job keeps its key blocked). Google errors are recorded on
 * the contact by the sync itself; unexpected errors (DB, bad payload) are
 * reported and NOT retried — the contact syncs on its next edit or "sync now".
 */
export async function contactGoogleSyncHandler(payload: unknown): Promise<{ ok: boolean }> {
  const parsed = contactGoogleSyncPayload.safeParse(payload);
  if (!parsed.success) {
    captureException(new Error("contact-google-sync: invalid payload"), {
      job: "contact-google-sync",
      reason: "invalid-payload",
    });
    return { ok: false };
  }
  try {
    await syncContactToGoogle(getDb(), parsed.data);
    return { ok: true };
  } catch (error) {
    // Drizzle errors embed the failed SQL with its params (contact data, ciphertext):
    // report only the error class, keep the ids for correlation.
    captureException(
      new Error(`contact-google-sync failed: ${error instanceof Error ? error.name : "unknown"}`),
      { job: "contact-google-sync", contactId: parsed.data.contactId },
    );
    return { ok: false };
  }
}
