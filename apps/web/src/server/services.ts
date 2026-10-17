import "server-only";

import type { TenantContext } from "@crm/core";
import type { AgentRow } from "@crm/core/agents";
import { listAgents } from "@crm/core/agents";
import type { LlmCredentialPublic } from "@crm/core/ai";
import { hasOrgLlmCredentials, listLlmCredentials } from "@crm/core/ai";
import type { AuditLogRow, ListAuditEventsInput } from "@crm/core/audit";
import { listAuditEvents } from "@crm/core/audit";
import type { MemoryEntryRow } from "@crm/core/brain";
import { listBrainEntries, listStaleBrainEntries } from "@crm/core/brain";
import type { ContactListRow, ListContactsInput } from "@crm/core/contacts";
import { listOrgContacts } from "@crm/core/contacts";
import { listThreadCards } from "@crm/core/drafts";
import type { ExternalConnectionPublic } from "@crm/core/external-connections";
import { getGoogleStatus, getGoogleSyncSummary } from "@crm/core/external-connections";
import type { ChannelConnectionRow } from "@crm/core/integrations";
import { listChannelConnectionsForTenant } from "@crm/core/integrations";
import type { KnowledgeEntryRow } from "@crm/core/knowledge";
import { listKnowledgeEntries } from "@crm/core/knowledge";
import type { BoardData, DealRow, FunnelRow, LabelRow, StageRow } from "@crm/core/leads";
import {
  getBoard,
  getDealForConversation,
  listContactLabels as listContactLabelsCore,
  listConversationLabels,
  listFunnels,
  listLabels,
  listStagesForFunnels,
  searchContacts,
} from "@crm/core/leads";
import type { MacroRow } from "@crm/core/macros";
import { listOrgMacros } from "@crm/core/macros";
import type {
  ContactTicketRow,
  ConversationDetailRow,
  ConversationListRow,
  ConversationView,
  ListConversationsInput,
  MessageSearchHit,
  MessageWithAuthorRow,
  TransferToMeRow,
} from "@crm/core/messaging";
import {
  getConversationDetail,
  getConversationLastInboundAt,
  listContactTickets as svcListContactTickets,
  listConversationCounts as svcListConversationCounts,
  listConversationMessages,
  listConversationMessagesAround,
  listMyTransfers as svcListMyTransfers,
  listTenantConversations,
  searchConversationMessages as svcSearchMessages,
} from "@crm/core/messaging";
import type { OnboardingChecklistRow } from "@crm/core/onboarding";
import { getChecklist } from "@crm/core/onboarding";
import type {
  OrganizationSettingsRow,
  OrgMember,
  PendingInvitationRow,
  UserOrganization,
} from "@crm/core/organizations";
import {
  getOrganizationSettings,
  listOrgInvitations,
  listOrgMembers,
  listUserOrganizations,
} from "@crm/core/organizations";
import type { PlatformSettingSummary } from "@crm/core/platform";
import { isProductConfigured, listPlatformSettingSummaries } from "@crm/core/platform";
import type { AgentSuggestionRow } from "@crm/core/suggestions";
import { listAgentSuggestions, listPendingMacroSuggestions } from "@crm/core/suggestions";
import type { TeamWithMembers } from "@crm/core/teams";
import { listTeams } from "@crm/core/teams";
import { getDb, withTenant } from "@crm/db";
import { cache } from "react";

/**
 * Server-side composition helpers: the only place UI code may reach @crm/core
 * services from — they bind the db handle internally so .tsx files never
 * import @crm/db (enforced by no-restricted-imports in eslint.config.js).
 */
export async function listRecentAuditEvents(
  ctx: TenantContext,
  opts?: ListAuditEventsInput,
): Promise<AuditLogRow[]> {
  return listAuditEvents(getDb(), ctx, opts);
}

export async function listMyOrganizations(userId: string): Promise<UserOrganization[]> {
  return listUserOrganizations(getDb(), userId);
}

/**
 * Request-cached single fetch of the org's channel connections — the
 * page derives several filtered views (waha/connected/all) that would
 * otherwise re-run the same query per render.
 */
const listChannelConnectionsCached = cache(
  async (ctx: TenantContext): Promise<ChannelConnectionRow[]> =>
    listChannelConnectionsForTenant(getDb(), ctx),
);

export async function listChannelConnections(ctx: TenantContext): Promise<ChannelConnectionRow[]> {
  return listChannelConnectionsCached(ctx);
}

export async function getGoogleConnectionStatus(
  ctx: TenantContext,
): Promise<ExternalConnectionPublic | null> {
  return getGoogleStatus(getDb(), ctx);
}

export async function getGoogleContactsSyncSummary(ctx: TenantContext) {
  return getGoogleSyncSummary(getDb(), ctx);
}

export async function getOnboardingChecklist(ctx: TenantContext): Promise<OnboardingChecklistRow> {
  return getChecklist(getDb(), ctx);
}

export async function listConversations(
  ctx: TenantContext,
  input?: ListConversationsInput,
): Promise<ConversationListRow[]> {
  return listTenantConversations(getDb(), ctx, input);
}

export async function listConversationCounts(
  ctx: TenantContext,
): Promise<Record<ConversationView, number>> {
  return svcListConversationCounts(getDb(), ctx);
}

/** Recent "ticket landed on me" transfer events — alerts bell (messaging:read). */
export async function listMyTransfers(ctx: TenantContext): Promise<TransferToMeRow[]> {
  return svcListMyTransfers(getDb(), ctx, { limit: 5, sinceDays: 14 });
}

/** Request-cached — ConversationPane and ConversationAside read the same ticket. */
export const getConversation = cache(
  async (ctx: TenantContext, id: string): Promise<ConversationDetailRow> =>
    getConversationDetail(getDb(), ctx, { conversationId: id }),
);

/** Prior tickets of the contact — aside history (messaging:read). */
export async function listContactTickets(
  ctx: TenantContext,
  contactId: string,
  excludeConversationId: string,
): Promise<ContactTicketRow[]> {
  return svcListContactTickets(getDb(), ctx, { contactId, excludeConversationId });
}

export async function listMessages(
  ctx: TenantContext,
  conversationId: string,
): Promise<MessageWithAuthorRow[]> {
  return listConversationMessages(getDb(), ctx, { conversationId });
}

/** B1 — window around a search hit (jump). NotFoundError on bad id. */
export async function listMessagesAround(
  ctx: TenantContext,
  conversationId: string,
  messageId: string,
): Promise<MessageWithAuthorRow[]> {
  return listConversationMessagesAround(getDb(), ctx, { conversationId, messageId });
}

/** B1 — in-thread text search hits for the header dropdown. */
export async function searchMessages(
  ctx: TenantContext,
  conversationId: string,
  query: string,
): Promise<MessageSearchHit[]> {
  return svcSearchMessages(getDb(), ctx, { conversationId, query });
}

export async function listMembers(ctx: TenantContext): Promise<OrgMember[]> {
  return listOrgMembers(getDb(), ctx);
}

/** Pending invitations — members page (invitation:create floor). */
export async function listInvitations(ctx: TenantContext): Promise<PendingInvitationRow[]> {
  return listOrgInvitations(getDb(), ctx);
}

/** Request-cached — inbox page and ConversationPane list the same sectors. */
export const listSectors = cache(async (ctx: TenantContext): Promise<TeamWithMembers[]> =>
  listTeams(getDb(), ctx),
);

export async function getOrgSettings(ctx: TenantContext): Promise<OrganizationSettingsRow> {
  return getOrganizationSettings(getDb(), ctx);
}

/** Platform-admin view of product settings — secrets redacted to flags. */
export async function getPlatformSettings(ctx: TenantContext): Promise<PlatformSettingSummary[]> {
  return listPlatformSettingSummaries(getDb(), ctx);
}

/**
 * Setup-wizard gate helper: returns only a boolean ("is the group ready?"),
 * no data — callers still do their own auth gate (the setup page requires a
 * session + platform_admin role). Exists because app routes can't import
 * @crm/db directly (eslint boundary) — all DB access goes through src/server.
 */
export async function productConfigured(group: "email" | "billing" | "meta" | "ai") {
  return isProductConfigured(getDb(), group);
}

// ---------- leads / funil ----------

export async function listOrgFunnels(ctx: TenantContext): Promise<FunnelRow[]> {
  return listFunnels(getDb(), ctx);
}

export interface FunnelWithStages {
  funnel: FunnelRow;
  stages: StageRow[];
}

/** Funnels + their stages — powers the "Virar lead" dialog's stage picker. */
export async function listFunnelsWithStages(ctx: TenantContext): Promise<FunnelWithStages[]> {
  const funnels = await listFunnels(getDb(), ctx);
  const stages = await listStagesForFunnels(
    getDb(),
    ctx,
    funnels.map((f) => f.id),
  );
  const byFunnel = new Map<string, StageRow[]>();
  for (const stage of stages) {
    const list = byFunnel.get(stage.funnelId);
    if (list) list.push(stage);
    else byFunnel.set(stage.funnelId, [stage]);
  }
  return funnels.map((funnel) => ({ funnel, stages: byFunnel.get(funnel.id) ?? [] }));
}

export async function getFunnelBoard(ctx: TenantContext, funnelId: string): Promise<BoardData> {
  return getBoard(getDb(), ctx, funnelId);
}

export async function listOrgLabels(ctx: TenantContext): Promise<LabelRow[]> {
  return listLabels(getDb(), ctx);
}

export type ConversationDeal = Awaited<ReturnType<typeof getDealForConversation>>;

export async function getConversationDeal(
  ctx: TenantContext,
  conversationId: string,
): Promise<ConversationDeal> {
  return getDealForConversation(getDb(), ctx, conversationId);
}

export async function listContactLabels(ctx: TenantContext, contactId: string) {
  return listContactLabelsCore(getDb(), ctx, contactId);
}

export async function getConversationLabels(
  ctx: TenantContext,
  conversationId: string,
): Promise<LabelRow[]> {
  return listConversationLabels(getDb(), ctx, conversationId);
}

export type ContactPickRow = Awaited<ReturnType<typeof searchContacts>>[number];

export async function searchOrgContacts(
  ctx: TenantContext,
  query?: string,
): Promise<ContactPickRow[]> {
  return searchContacts(getDb(), ctx, query);
}

export type { ContactListRow };

export async function listContactsPage(
  ctx: TenantContext,
  input: ListContactsInput = {},
): Promise<ContactListRow[]> {
  return listOrgContacts(getDb(), ctx, input);
}

export type WahaConnectionPick = Pick<ChannelConnectionRow, "id" | "name">;

/** WAHA connections able to start outbound conversations (connected only). */
export async function listWahaConnections(ctx: TenantContext): Promise<WahaConnectionPick[]> {
  const connections = await listChannelConnectionsCached(ctx);
  return connections
    .filter((c) => c.kind === "waha" && c.status === "connected")
    .map(({ id, name }) => ({ id, name }));
}

export type ConnectedChannelPick = Pick<ChannelConnectionRow, "id" | "name" | "kind">;

/** Every connected channel — the inbox channel filter's option set. */
export async function listConnectedChannels(ctx: TenantContext): Promise<ConnectedChannelPick[]> {
  const connections = await listChannelConnectionsCached(ctx);
  return connections
    .filter((c) => c.status === "connected")
    .map(({ id, name, kind }) => ({ id, name, kind }));
}

export type { DealRow };

// --- AI (observer v1) ----------------------------------------------------------

export async function listOrgLlmCredentials(ctx: TenantContext): Promise<LlmCredentialPublic[]> {
  return listLlmCredentials(getDb(), ctx);
}

/** Boolean credential probe for UI gating — never decrypts the keys. */
export async function hasLlmCredential(ctx: TenantContext): Promise<boolean> {
  return withTenant(getDb(), ctx.organizationId, (tx) =>
    hasOrgLlmCredentials(tx, ctx.organizationId),
  );
}

export async function listOrgAgents(ctx: TenantContext): Promise<AgentRow[]> {
  return listAgents(getDb(), ctx);
}

export async function listOrgKnowledge(ctx: TenantContext): Promise<KnowledgeEntryRow[]> {
  return listKnowledgeEntries(getDb(), ctx);
}

export async function listOrgSuggestions(ctx: TenantContext): Promise<AgentSuggestionRow[]> {
  return listAgentSuggestions(getDb(), ctx, { limit: 100 });
}

export async function listMacros(ctx: TenantContext): Promise<MacroRow[]> {
  return listOrgMacros(getDb(), ctx);
}

export async function listPendingMacros(ctx: TenantContext): Promise<AgentSuggestionRow[]> {
  return listPendingMacroSuggestions(getDb(), ctx);
}

export async function listOrgBrainEntries(ctx: TenantContext): Promise<MemoryEntryRow[]> {
  return listBrainEntries(getDb(), ctx, { limit: 200 });
}

export async function listOrgStaleBrainEntries(ctx: TenantContext): Promise<MemoryEntryRow[]> {
  return listStaleBrainEntries(getDb(), ctx);
}

// --- AI thread cards (drafts + nudges) --------------------------------------

/** Pending thread cards for the conversation (messaging:write). */
export async function listThreadCardsForConversation(
  ctx: TenantContext,
  conversationId: string,
): Promise<AgentSuggestionRow[]> {
  return listThreadCards(getDb(), ctx, conversationId);
}

/** Last inbound timestamp — draft staleness, independent of the listed window. */
export async function getLastInboundAt(
  ctx: TenantContext,
  conversationId: string,
): Promise<Date | null> {
  return getConversationLastInboundAt(getDb(), ctx, { conversationId });
}
