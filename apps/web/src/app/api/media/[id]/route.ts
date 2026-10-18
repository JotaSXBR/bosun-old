import type { TenantContext } from "@crm/core";
import { providerForConnection } from "@crm/core/integrations";
import type { MediaResolverDeps } from "@crm/core/messaging";
import { resolveMessageMedia } from "@crm/core/messaging";
import type { Database } from "@crm/db";
import { getDb } from "@crm/db";

import { mediaResponse } from "@/lib/media-response";
import { routeErrorResponse } from "@/lib/route-error";
import { getStorage } from "@/server/storage";
import { getTenantContext } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE_TAG = "api.media";

/** Outbound uploads come from object storage; inbound media is fetched through the provider. */
async function resolveMedia(
  db: Database,
  tenant: TenantContext,
  messageId: string,
): Promise<{ body: Uint8Array; contentType?: string; filename?: string } | null> {
  const deps: MediaResolverDeps = {
    downloadObject: (key) => getStorage().download(key),
    fetchProviderMedia: async (connectionId, url) => {
      const provider = await providerForConnection(db, tenant.organizationId, connectionId);
      const media = await provider.fetchMedia?.(url);
      if (!media) return null;
      return { body: media.body, contentType: media.contentType ?? undefined };
    },
    fetchMessageMedia: async (connectionId, chatId, externalId) => {
      const provider = await providerForConnection(db, tenant.organizationId, connectionId);
      const media = await provider.fetchMessageMedia?.(chatId, externalId);
      if (!media) return null;
      return { body: media.body, contentType: media.contentType ?? undefined };
    },
  };
  return resolveMessageMedia(db, tenant, { input: { messageId }, deps });
}

/**
 * Authenticated media proxy. Inbound media lives on the channel provider's
 * host (not browser-reachable); outbound uploads live in object storage
 * under a tenant key. The browser only ever sees this same-origin URL.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const tenant = await getTenantContext();
  if (!tenant) {
    return Response.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;

  try {
    const media = await resolveMedia(getDb(), tenant, id);
    if (!media) return Response.json({ ok: false }, { status: 404 });
    return mediaResponse(media.body, media.contentType, media.filename);
  } catch (error) {
    return routeErrorResponse(error, ROUTE_TAG);
  }
}
