# Plan — Identidade do contato por telefone (v1, frente 1)

- **Origem**: `docs/intent/bosun-v1.md` (frente 1) · `docs/product/contacts-identity.md`
- **Lifecycle**: spec → plan → build → test → review → ship
- **Data**: 2026-10-20

## Objetivo

Uma mensagem que chega de um `@lid` do WhatsApp cria (ou reaproveita) o
contato pelo **telefone**, sem duplicata vazia, e o contato novo vai para o
Google Contacts já com o número.

## Contexto

Decisões do fundador (entrevista de 2026-10-20), não só o quê:

- **O telefone é a identidade** (`<dígitos>@c.us`); o LID é só alias em
  `contacts.metadata.lid`. Sem tabela nova (suficiente para v1).
- O telefone vem do `_data.Info.SenderAlt` do webhook. **Verificado no staging**
  (WAHA 2026.9.2 GOWS): `SenderAlt = "<dígitos>:<device>@s.whatsapp.net"`; o
  sufixo `:<device>` é removido. Fixture `waha-webhooks.json` já tem o formato.
- **Fallback `GET /lids/{lid}` fica fora**: o caso confirmado é coberto por
  `SenderAlt`. Sem telefone, o contato fica provisório pelo LID e se junta
  quando a próxima mensagem trouxer `SenderAlt`.
- **Sem backfill em lote**: só há dados de teste; o contato LID antigo é
  mesclado quando a pessoa escrever de novo.
- O nome do WhatsApp só nomeia contato **novo**, nunca sobrescreve (vários
  atendentes podem escrever do mesmo número). Separar "Nome @ Empresa" e
  preencher empresa **não** é desta frente: vira sugestão do observer (frente 2).
- Google: `phoneNumbers: [{ value: "+E164" }]` **sem `type`** (pode ser fixo);
  `names` é campo único. O mapeador (`toPerson`) já faz isso; contato novo
  passa a ser enfileirado na criação, não só pela varredura de 10 min.
- `conversations.external_id` passa a ser o `channelUserId` do contato (telefone):
  assim o mesmo ticket serve inbound por LID e outbound-first por telefone.
  Presença (`contact.presence`) chega com `chatId` LID e é resolvida pelo alias.
- Trabalho em **slices**, um commit local por slice verificado, numa branch
  `feat/contact-identity`. **Sem PR a cada slice**: o PR só quando o fundador pedir.

## Fontes consultadas

| Tema                          | Versão / alvo           | Fonte                                                          | Data       | O que confirmou                                                                                     |
| ----------------------------- | ----------------------- | -------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| WAHA `SenderAlt` / LID        | 2026.9.2 (GOWS)         | Context7 `/devlikeapro/waha-docs` + payload real do staging    | 2026-10-20 | `from` = LID; `_data.Info.SenderAlt` = `<dígitos>:<device>@s.whatsapp.net`; webhook respondeu `200` |
| People API `createContact`    | v1                      | Context7 `/websites/developers_google_people`                  | 2026-10-20 | `phoneNumbers[].value`; `canonicalForm` só saída; `type` opcional; `names` é singleton (2 → 400)    |
| Drizzle índice único parcial  | versão do `packages/db` | **UNVERIFIED** — consultar Context7 antes da migração (task 3) | —          | sintaxe de índice sobre expressão `(metadata->>'lid')` com `where`                                  |
| GOWS: envio para `<tel>@c.us` | 2026.9.2                | **UNVERIFIED** — validar no staging (task 6)                   | —          | resposta ao contato sai para o chat do telefone e é entregue                                        |

## Escopo

packages/channels/src/domain.ts
packages/channels/src/adapters/waha-schemas.ts
packages/channels/src/adapters/waha-payloads.ts
packages/channels/src/adapters/waha-lid.test.ts
packages/channels/src/adapters/channels.test.ts
packages/channels/src/adapters/**fixtures**/**
packages/core/src/modules/messaging/**
packages/core/src/modules/contacts/**
packages/core/src/modules/external-connections/**
packages/db/src/schema/messaging.ts
packages/db/migrations/**
apps/web/src/app/api/webhooks/channels/**

## Fora de escopo

- Tool/sugestão do observer para nome e empresa (frente 2).
- Fallback `GET /lids/{lid}` e job de backfill em lote.
- UI de contatos e do atendimento (reforma de navegação, frente 4).
- Pull Google → Bosun (nome/empresa do contato do Google). Pergunta aberta na spec.
- Endereço/aniversário por opt-in e as pendências de segurança da slice 2 do Google.
- Entidade "empresa" ligando contatos.

## Tarefas

Detalhe com acceptance + verify em `tasks/todo.md`. Ordem por dependência:

1. **Canal**: `SenderAlt` → telefone. Participant carrega `channelUserId` (telefone)
   e `lid` (alias). Só `packages/channels`.
2. **Contato por telefone**: `upsertContact` por telefone, guarda `metadata.lid`,
   nome só em contato novo, ticket usa `contact.channelUserId`, presença via alias.
3. **Índice único do alias** (migração `0036`) + checagem de duas pessoas com o mesmo LID.
4. **Mesclagem** do contato LID no contato do telefone (conversas, mensagens,
   deals, cérebro, site-chat), com conflito de ticket ativo.
5. **Google no contato novo**: enfileirar a sincronização na criação/promoção.
6. **Checkpoint no staging**: mensagem real de um LID, contato com telefone,
   contato no Google, resposta entregue.

## Critérios de pronto

- [ ] `pnpm verify` verde por slice; `pnpm verify:full` no fim (toca DB)
- [ ] Testes alvo: unit do canal; `*.int.test.ts` de ingest, mesclagem e isolamento entre orgs
- [ ] Docs atualizadas: `docs/product/contacts-identity.md` (status), `channel-whatsapp.md` §8, `TODO.md`
- [ ] Validado no staging com o WAHA real
