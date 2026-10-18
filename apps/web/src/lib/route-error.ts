import { AuthorizationError, DomainError, NotFoundError } from "@crm/core";
import { captureException } from "@crm/observability";

/** Maps domain errors of the authenticated API routes to a status; anything else is reported as 500. */
export function routeErrorResponse(error: unknown, route: string): Response {
  if (error instanceof NotFoundError) return Response.json({ ok: false }, { status: 404 });
  if (error instanceof AuthorizationError) return Response.json({ ok: false }, { status: 403 });
  if (error instanceof DomainError) {
    return Response.json({ ok: false, error: error.code }, { status: 400 });
  }
  captureException(error, { route });
  return Response.json({ ok: false }, { status: 500 });
}
