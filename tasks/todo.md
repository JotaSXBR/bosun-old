# Todo — Identidade do contato por telefone

Plano: `tasks/plan.md`. Um commit local por slice, na branch `feat/contact-identity`.
Sem PR a cada slice.

## 1. Canal: `SenderAlt` vira telefone (S)

- [x] `wahaMessageSchema` expõe `_data.Info.SenderAlt`
- [x] `wahaToInbound`: de `@lid` com `SenderAlt` válido → `from.channelUserId = <dígitos>@c.us` e `from.lid = <lid>@lid`; sem `SenderAlt` ou formato inválido → mantém o LID
- [x] Remove o sufixo `:<device>`; só aceita `^[1-9]\d{7,14}@c\.us$` como identidade

**Acceptance:** o fixture `waha-webhooks.json` (`5511999888777:53@s.whatsapp.net`) gera `5511999888777@c.us`; `SenderAlt` malformado nunca vira identidade.
**Verify:** `pnpm --filter @crm/channels test` · `pnpm typecheck`
**Dependências:** nenhuma

## 2. Contato por telefone na ingestão (M)

- [x] `upsertContact` por `channelUserId` (telefone); guarda `metadata.lid`
- [x] Nome do WhatsApp só em contato **novo** (não sobrescreve)
- [x] Ticket usa `contact.channelUserId`; presença resolve `chatId` LID pelo alias

**Acceptance:** mensagem por LID com `SenderAlt` reaproveita o contato existente do telefone; outbound-first e inbound caem no mesmo ticket; presença por LID chega ao ticket certo.
**Verify:** `pnpm --filter @crm/core test:integration` (ingest, outbound-first, presença)
**Dependências:** 1

## 3. Índice único do alias (S)

- [x] Confirmar a sintaxe do Drizzle (Context7) e registrar em `## Fontes consultadas`
- [x] Migração `0036`: índice único parcial `(organization_id, (metadata->>'lid'))`
- [x] `pnpm db:generate` revisado; teste: o mesmo LID não vira dois contatos na mesma org e é livre em outra org

**Acceptance:** o banco recusa dois contatos com o mesmo LID na org; isolamento entre orgs preservado.
**Verify:** `pnpm db:migrate` · teste de integração de isolamento
**Dependências:** 2

## 4. Mesclagem do contato LID no contato do telefone (M)

- [x] Ao chegar `SenderAlt`, se existe contato com `channelUserId = <lid>`, mescla no do telefone numa transação
- [x] Reaponta conversas (`contact_id` e `external_id`), mensagens, deals, cérebro e site-chat
- [x] Conflito de ticket ativo (os dois contatos têm ticket aberto na mesma conexão): une as mensagens no ticket do telefone
- [x] Idempotente; o contato LID some; nome: manual > Google > push name

**Acceptance:** nenhuma mensagem ou conversa se perde; rodar duas vezes não muda nada; não mistura dados entre organizações.
**Verify:** teste de integração (cenário sem conflito, com conflito, e cross-org)
**Dependências:** 3

## Checkpoint: após 1-4

- [ ] `pnpm verify` verde · `pnpm verify:full` verde
- [ ] Revisão do fundador antes do passo Google

## 5. Google no contato novo (S)

- [ ] Contato criado ou promovido a telefone enfileira `contact-google-sync` (padrão `enqueueAvatar` em `IngestDeps`)
- [ ] Payload: `phoneNumbers: [{ value: "+E164" }]` sem `type`; `names` com uma entrada

**Acceptance:** contato novo aparece no Google pelo número, sem esperar a varredura de 10 min, sem duplicar um contato que já exista no Google.
**Verify:** `google-contact-sync.int.test.ts` com o cliente fake de People; `pnpm verify:full`
**Dependências:** 2

## 6. Checkpoint no staging (S)

- [ ] Deploy no staging; mensagem real de um número que chega como LID
- [ ] Contato nasce com telefone, sem duplicata; aparece no Google
- [ ] Resposta do atendente é entregue ao chat do telefone (valida a premissa GOWS)
- [ ] Docs: `contacts-identity.md`, `channel-whatsapp.md` §8, `TODO.md`

**Acceptance:** os quatro itens acima, com o WAHA 2026.9.2 real.
**Dependências:** 1-5
