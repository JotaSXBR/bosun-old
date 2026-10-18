import type { Database } from "@crm/db";
import { captureException } from "@crm/observability";

import type { TenantContext } from "../../tenant/context";
import { recordAuditEvent } from "../audit";

/** Audit is post-commit best-effort — a logging failure must not fail the mutation. */
export function audit(
  db: Database,
  ctx: TenantContext,
  { action, id: dealId }: { action: string; id: string },
): void {
  recordAuditEvent(db, ctx, {
    action,
    targetType: "deal",
    targetId: dealId,
    metadata: { dealId },
  }).catch((error: unknown) => captureException(error, { module: "leads", action }));
}
