"use server";

import { enqueueOrganizationOnboarding } from "@crm/automation";
import type { TenantContext } from "@crm/core";
import { recordAuditEvent } from "@crm/core/audit";
import { completeStep } from "@crm/core/onboarding";
import { getDb } from "@crm/db";
import { captureException } from "@crm/observability";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getAuth } from "@/server/auth";

const inputSchema = z.object({
  name: z.string().trim().min(2, "Informe o nome da organização").max(80),
});

export type CreateOrganizationResult = { ok: true } | { ok: false; error: string };

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "org";
}

type Auth = ReturnType<typeof getAuth>;
type RequestHeaders = Awaited<ReturnType<typeof headers>>;

// checkOrganizationSlug returns { status: boolean } — true when available.
async function findAvailableSlug(
  auth: Auth,
  requestHeaders: RequestHeaders,
  baseSlug: string,
): Promise<string | null> {
  try {
    const check = await auth.api.checkOrganizationSlug({
      body: { slug: baseSlug },
      headers: requestHeaders,
    });
    return check.status ? baseSlug : `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`;
  } catch (error) {
    captureException(error, { action: "organization.create.checkSlug" });
    return null;
  }
}

async function createOrg(
  auth: Auth,
  requestHeaders: RequestHeaders,
  name: string,
  slug: string,
): Promise<{ id: string } | null> {
  try {
    return await auth.api.createOrganization({
      body: { name, slug },
      headers: requestHeaders,
    });
  } catch (error) {
    captureException(error, { action: "organization.create" });
    return null;
  }
}

type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

/** Audit event + activation checklist step. The checklist can never break organization creation. */
async function recordOrganizationCreated(tenantCtx: TenantContext, orgId: string): Promise<void> {
  await recordAuditEvent(getDb(), tenantCtx, {
    action: "organization.created",
    targetType: "organization",
    targetId: orgId,
  });

  // Checklist de ativação nasce endowed: org criada já conta (1/5).
  try {
    await completeStep(getDb(), tenantCtx, "org_created");
  } catch (error) {
    captureException(error, { action: "organization.checklist" });
  }
}

/** Background onboarding must never break organization creation. */
async function enqueueOnboarding(organizationId: string, actorUserId: string): Promise<void> {
  try {
    await enqueueOrganizationOnboarding({ organizationId, actorUserId });
  } catch (error) {
    captureException(error, { action: "organization.enqueueOnboarding" });
  }
}

async function provisionOrganization(input: {
  auth: Auth;
  requestHeaders: RequestHeaders;
  session: Session;
  name: string;
}): Promise<CreateOrganizationResult> {
  const { auth, requestHeaders, session, name } = input;
  const slug = await findAvailableSlug(auth, requestHeaders, slugify(name));
  const org = slug ? await createOrg(auth, requestHeaders, name, slug) : null;
  if (!org) return { ok: false, error: "Não foi possível criar a organização." };

  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers: requestHeaders,
  });

  const tenantCtx = {
    organizationId: org.id,
    userId: session.user.id,
    role: "owner" as const,
    isPlatformAdmin: session.user.role === "platform_admin",
  };
  await recordOrganizationCreated(tenantCtx, org.id);
  await enqueueOnboarding(org.id, session.user.id);

  redirect("/app");
}

export async function createOrganization(input: unknown): Promise<CreateOrganizationResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos" };
  }

  const auth = getAuth();
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return { ok: false, error: "Sessão expirada. Entre novamente." };

  return provisionOrganization({ auth, requestHeaders, session, name: parsed.data.name });
}
