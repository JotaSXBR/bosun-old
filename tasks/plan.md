# Plan — Google Contacts: motor de sync (slice 3a/3)

- **Origem**: `TODO.md` → P2 Google (slice 3) · `docs/product/contacts-google-sync.md` (§ Sync engine)
- **Lifecycle**: spec ✓ → plan → build → test → review → ship
- **Data**: 2026-10-16

## Objetivo

Um contato do Bosun é espelhado no Google (People API) por um job
sequencial, e a organização dispara o envio de toda a base com o botão
"Sincronizar agora" no card do Google — validável ponta a ponta no staging.

## Contexto

Decisões do gate de esclarecimento (2026-10-16):

- **Regra do usuário (mantida)**: os dados vivem no Bosun e funcionam sem
  Google; o Google é só um espelho de backup, push-only, e só roda com uma
  conexão `connected`.
- **Fatiamento da slice 3 em dois planos**: 3a (este) = motor — cliente da
  People API, mapeamento, job que envia **um** contato, botão "Sincronizar
  agora" e os pré-requisitos de segurança. 3b = automação — gatilho nas
  edições, varredura periódica, lotes (`batch*Contacts`), contadores e faixa
  de erro no card. O 3b depende do 3a.
- **Gatilho (vale para o 3b)**: híbrido — enfileira nas edições manuais e uma
  varredura periódica (cron, como o `observer-scan`) cobre contatos criados
  pelo ingest e conexões feitas depois.
- **Sync inicial por confirmação**: ao conectar, nada é enviado sozinho; o
  card mostra quantos contatos estão prontos e o botão **Sincronizar agora**
  enfileira um job por contato elegível. Reexecutar é idempotente
  (`resourceName` + hash do payload).
- **LGPD — decisão do usuário: sempre espelhar tudo** (inclui endereço e
  aniversário), sem opt-in por organização. A organização escolhe conectar o
  Google e confirma o envio com o botão; o risco fica registrado aqui e
  no spec.
- **Pré-requisitos de segurança entram no 3a**: rejeitar caracteres de
  controle/bidi em nome, empresa, cargo, endereço e notas, e credenciais
  embutidas em `urls` (`https://user:pass@…`), porque esses valores passam a
  sair do Bosun.
- **Regras da People API (conferidas na doc oficial em 2026-10-16)**:
  `updatePersonFields` é obrigatório e **substitui** os campos listados;
  `etag` divergente → 400 `failedPrecondition` (reler e tentar uma vez);
  mutates do mesmo usuário devem ser sequenciais; `searchContacts` casa por
  prefixo e exige um pedido de aquecimento com consulta vazia (até 30
  resultados), então todo candidato é conferido por igualdade exata;
  `createContact` dá 400 se um campo singleton (`names`, `birthdays`,
  `biographies`) tiver mais de um valor; `batch*Contacts` aceita até 200 por
  chamada (3b).
- **Ordem por conexão com `key_strict_fifo`** (pg-boss 12.35.0, tipos
  instalados): a fila é criada com `policy: 'key_strict_fifo'` e todo envio
  leva `singletonKey = google:<organizationId>`; a People API exige mutates
  sequenciais por usuário, e a política garante FIFO por chave sem serializar
  as outras organizações. **Cuidado documentado nos tipos**: um job `failed`
  ou em retry segura os sucessores da mesma chave. Por isso o handler nunca
  deixa um job falhar por erro de um contato: grava `metadata.google.lastError`
  e conclui; o 429 usa backoff limitado dentro do cliente (não os `retry*` do
  pg-boss) e, esgotado, vira `lastError` — a varredura do 3b tenta de novo.
- **Elegibilidade**: contato com telefone de WhatsApp (`<dígitos>@c.us` →
  E.164 `+<dígitos>`) **ou** e-mail; sem nenhum dos dois é ignorado. Nome ausente
  → o campo `names` não é enviado. Foto, campos custom, grupos e deletes
  nunca são enviados.
- **Estado do sync no próprio contato**: `contacts.metadata.google`
  (`resourceName`, `etag`, `payloadHash`, `lastSyncedAt`), gravado sem alterar
  `updated_at` (para não reativar a varredura do 3b). Sem migração.
- **Falha de token**: `invalid_grant` no refresh → conexão `needs_reauth`, o
  job não faz nada e o card avisa (reaproveita o fluxo da slice 1).

## Fontes consultadas

Regra do projeto: decisão sobre biblioteca ou API externa se apoia em
documentação atual da versão em uso, não em memória.

| Tema                  | Versão / alvo            | Fonte                                                                                                                              | Data       | O que confirmou                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| People API (contatos) | REST v1                  | `developers.google.com/people/api/rest/v1/people/{updateContact,searchContacts,createContact,batch*}`                              | 2026-10-16 | etag/`failedPrecondition`, `updatePersonFields` substitutivo, mutates sequenciais, aquecimento, ≤200                                                                                                                                                                                                                                 |
| OAuth do Google       | web server flow          | `developers.google.com/identity/protocols/oauth2/web-server`                                                                       | 2026-10-15 | state, refresh, `invalid_grant`, revoke, consentimento granular                                                                                                                                                                                                                                                                      |
| pg-boss               | 12.35.0 (`package.json`) | tipos instalados `node_modules/pg-boss/dist/types.d.ts` (Context7 indisponível: chave inválida)                                    | 2026-10-16 | `policy: 'key_strict_fifo'`, `singletonKey`, `localConcurrency`, `retry*`, job `failed` segura chave                                                                                                                                                                                                                                 |
| zod                   | 4.6.5 (`package.json`)   | Context7 `/colinhacks/zod` (API REST, chave nova)                                                                                  | 2026-10-16 | `z.httpUrl()` (= `z.url` http(s) + hostname de domínio), sem opção de credenciais → `.refine` com `new URL()`, refine devolve falso e nunca lança, mensagem via `{ error }`                                                                                                                                                          |
| People API (cliente)  | REST v1                  | `developers.google.com/people/api/rest/v1/{people, people/get, people/updateContact, people/searchContacts, people/createContact}` | 2026-10-16 | `POST people:createContact`, `PATCH {people/*}:updateContact` (corpo com `metadata.sources` = type/id/etag lidos antes), `GET people:searchContacts?query&readMask&pageSize`, `GET {resourceName}?personFields`; `names[].unstructuredName`; `birthdays[].date{year,month,day}` (sempre `date`); `addresses[].formattedValue` aceito |
| Erros das APIs Google | AIP-193/194              | `cloud.google.com/apis/design/errors`                                                                                              | 2026-10-16 | corpo `{error:{code,message,status}}` (`NOT_FOUND`, `RESOURCE_EXHAUSTED`…); retry com backoff para indisponibilidade/cota                                                                                                                                                                                                            |

Context7 reconfigurado em 2026-10-16 (a chave antiga era inválida); as ferramentas MCP só valem após reiniciar a sessão, até lá consulta-se a API REST oficial do Context7.
Novas dúvidas de API durante o build entram nesta tabela **antes** do código.

## Escopo

- `packages/core/src/modules/contacts/**`
- `packages/core/src/modules/external-connections/**`
- `packages/automation/src/**`
- `apps/web/src/server/actions/external-connections.ts`
- `apps/web/src/server/services.ts`
- `apps/web/src/app/app/settings/channels/**`
- `apps/web/messages/pt-BR.json`
- `apps/web/e2e/**`

## Fora de escopo

- Gatilho automático nas edições, varredura periódica, uso de
  `batchCreateContacts`/`batchUpdateContacts`, contadores avançados e faixa
  de erro no card (plano 3b).
- Pull / sincronização bidirecional, propagação de deletes, fotos, campos
  custom, grupos/etiquetas (non-goals do spec).
- Verificação do app no Google (fica para o fim do desenvolvimento).
- Migrações de banco.

## Tarefas

1. **Endurecer o perfil (pré-requisitos)** — o zod de `updateContactProfileInput`
   (e a criação) rejeita caracteres de controle/bidi e `urls` com credenciais;
   testes unitários e de integração.
2. **Cliente da People API** — interface injetável (`searchByPhoneOrEmail`
   com aquecimento, `createContact`, `getContact`, `updateContact` com etag)
   sobre `fetch`, com backoff em 429/5xx e erros tipados; fake para testes;
   `getValidAccessToken` no serviço (renova o token expirado, persiste, marca
   `needs_reauth`).
3. **Mapeamento Bosun → Person** — função pura: `names`, `phoneNumbers`,
   `emailAddresses`, `organizations`, `addresses`, `biographies`, `birthdays`,
   `urls`; regras de singleton, elegibilidade e hash do payload; testes
   unitários.
4. **Job `contact-google-sync`** — envia um contato: resolve a conexão
   `connected`, usa `metadata.google.resourceName` ou procura candidatos (igualdade
   exata de telefone/e-mail), cria ou atualiza com etag (uma releitura em
   conflito), pula se o hash não mudou, grava `metadata.google` sem mexer em
   `updated_at`; erro de um contato vira `lastError` e o job **conclui** (nunca
   segura a chave); fila criada em `boss.ts` com `policy: 'key_strict_fifo'` e
   envio sempre com `singletonKey`; teste de integração com o cliente falso.
5. **Botão "Sincronizar agora" no card** — a action enfileira um job por
   contato elegível (em páginas); o card mostra quantos estão prontos,
   quantos já sincronizaram e a última sincronização; só `integrations:manage`
   vê o botão; textos pt-BR.

Checkpoint após a tarefa 4: `pnpm verify` + integração verdes antes de tocar na
UI. Cada tarefa fecha com um commit atômico.

Checkpoint final: teste manual no staging com o Google real (o usuário faz o
consentimento, eu leio os logs pelo Coolify se algo falhar).

Detalhe de acceptance + verify por task em `tasks/todo.md`.

## Riscos

| Risco                                                         | Impacto | Mitigação                                                                               |
| ------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| Duplicar contatos no Google (match fraco)                     | Alto    | `searchContacts` é por prefixo: conferir igualdade exata de E.164/e-mail antes de criar |
| Sobrescrever edição feita no Google (etag)                    | Médio   | Atualizar só com `updatePersonFields` explícito; conflito → reler uma vez e reaplicar   |
| Upload em massa para a conta errada                           | Alto    | Nada é enviado ao conectar; só o botão, que mostra a conta e a contagem                 |
| Cota/429 da People API                                        | Médio   | Backoff exponencial no cliente; fila sequencial; cota por projeto (cada org tem a sua)  |
| Dados pessoais (endereço, aniversário) saindo do Bosun (LGPD) | Médio   | Decisão registrada do usuário; envio só após o botão; nota no spec                      |
| Token revogado no meio da execução                            | Médio   | `invalid_grant` → `needs_reauth`, jobs seguintes não fazem nada                         |
| Caracteres de controle/bidi chegando ao Google                | Baixo   | Tarefa 1 rejeita no zod antes de qualquer envio                                         |

## Critérios de pronto

- [x] `pnpm verify` verde
- [x] `pnpm verify:full` verde (toca job, banco e UI)
- [x] Testes: elegibilidade, mapeamento (singletons), igualdade exata no match,
      conflito de etag, 429 com backoff, token revogado, hash sem mudança =
      sem chamada ao Google
- [ ] Teste manual no staging: Sincronizar agora cria os contatos no Google e
      repetir não duplica
- [x] Docs atualizadas: `docs/product/contacts-google-sync.md` (LGPD, botão,
      fila sequencial) e `docs/domains` se mudar o modelo
- [x] `TODO.md`: slice 3a concluída, 3b listada
