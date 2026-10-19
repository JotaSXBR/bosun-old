import type { Database } from "@crm/db";
import { withTenant } from "@crm/db";

import { findOrCreateAgentByKind } from "../agents";

/**
 * The org's drafter — dedicated `kind='drafter'` agent row, lazily created
 * on first use with a sane default persona; editable afterwards through
 * the regular agents settings UI (`ai:manage`).
 */
export async function findOrCreateDrafter(db: Database, organizationId: string) {
  return withTenant(db, organizationId, (tx) =>
    findOrCreateAgentByKind(tx, organizationId, {
      kind: "drafter",
      defaults: {
        name: "Drafter",
        specialty: "Sugestões de resposta para revisão humana",
        status: "active",
        systemPrompt:
          "Você escreve rascunhos de resposta no tom da empresa: cordial, direto, " +
          "sem jargão técnico com o cliente. Trate o cliente por 'você'.",
        toolsAllowlist: [],
      },
    }),
  );
}

/**
 * The org's observer — dedicated `kind='observer'` agent row, lazily
 * created on first analysis. Owner-only editable (system agent gate in
 * agents/service.ts); its `systemPrompt`/`modelRef` steer the job.
 */
export async function findOrCreateObserver(db: Database, organizationId: string) {
  return withTenant(db, organizationId, (tx) =>
    findOrCreateAgentByKind(tx, organizationId, {
      kind: "observer",
      defaults: {
        name: "Observer",
        specialty: "Análise pós-atendimento e aprendizado operacional",
        status: "active",
        systemPrompt: "",
        toolsAllowlist: [],
      },
    }),
  );
}
