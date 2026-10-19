# Plan — Google Contacts: sync automático (slice 3b/3)

- **Origem**: `TODO.md` → P2 Google (slice 3b) · `docs/product/contacts-google-sync.md` (§ Sync engine, "Known limits (3b)")
- **Lifecycle**: spec ✓ → plan → build → test → review → ship
- **Data**: 2026-10-18

## Objetivo

Depois do primeiro "Sincronizar agora", o espelho no Google se mantém sozinho
(edições na UI e varredura periódica), e o card mostra quantos contatos
falharam, com faixa de aviso e a data da última varredura — sem varrer a base
inteira a cada carregamento da página.

## Contexto

Decisões do gate de esclarecimento (2026-10-18):

- **3a validada no staging (2026-10-17)**: conectado, 1 contato sincronizado,
  data da última sincronização exibida. O plano da 3a foi arquivado em
  `tasks/plan-google-sync-motor.done.md`.
- **Sem `batch*Contacts`**: mantém **1 job por contato** em `key_strict_fifo`
  (idempotente, erro isolado por contato, 429 já tem backoff). Batch só se a
  base real justificar — fica registrado como não-objetivo, não como dívida.
- **Gatilho = edição manual + varredura**. Editar/criar contato na UI
  enfileira o job; um cron cobre o que a UI não vê (contatos criados pelo
  ingest, falhas, conexões novas).
- **Consentimento explícito e persistido** (LGPD, decisão da 3a: "dados só
  saem após o clique"). O primeiro "Sincronizar agora" grava
  `external_connections.auto_sync_since`; **gatilho e varredura só rodam com
  esse marcador e conexão `connected`**. Desconectar apaga a linha, então
  reconectar exige novo clique. Inferir o consentimento de "algum contato já
  sincronizado" foi descartado: é implícito e quebra se o primeiro envio
  falhar. Custo: **uma migração** (a 3a não teve).
- **O botão passa a enfileirar um job de varredura** em vez de enfileirar
  contato a contato dentro da requisição (limite "sequencial na requisição"
  da 3a). Botão e cron usam o **mesmo** handler (`contact-google-sweep`);
  com `organizationId` no payload varre uma org, sem ele varre todas as
  elegíveis.
- **O que a varredura enfileira (SQL, sem migração de metadata)**: contato
  elegível cujo `metadata.google` (a) nunca foi tentado, (b) foi editado
  depois da última tentativa (`updated_at > lastAttemptAt`) ou (c) tem
  `lastError` com tentativa há mais de 1 h (backoff — erro permanente não
  vira martelada a cada tick). `lastAttemptAt` é novo, gravado pelo
  `syncContactToGoogle` em **todo** término (criou, atualizou, `unchanged`
  ou falhou), porque `unchanged` hoje não grava nada e o contato voltaria a
  ser "pendente" para sempre. Fallback `coalesce(lastAttemptAt, lastSyncedAt)`
  cobre os contatos já sincronizados na 3a.
- **Elegibilidade duplicada em SQL**: o pré-filtro SQL (`@c.us` com 8–15
  dígitos ou e-mail não vazio) espelha `isEligible`; o JS continua sendo a
  autoridade final e um teste de paridade impede divergência.
- **Resumo do card em uma consulta** (`count(*) filter …` + `max`) em vez de
  paginar todos os contatos no carregamento da página.
- **Card**: contador de falhas (`lastError` presente) com faixa de aviso,
  última sincronização e **última varredura automática**
  (`external_connections.last_sweep_at`, gravado pelo cron).
- **Higiene do TODO da 3b incluída**: cliente People reaproveitado dentro do
  handler/varredura e `metadata.google` fora do navegador (dialog recebe só
  as chaves do perfil). Pequenas e já listadas no TODO.

## Fontes consultadas

Nenhuma API externa nova: a slice só reaproveita a People API e o pg-boss já
mapeados no plano da 3a (`tasks/plan-google-sync-motor.done.md`).

| Tema                 | Versão / alvo            | Fonte                                                                                                                    | Data       | O que confirmou                                                                             |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------- |
| pg-boss              | 12.35.0 (`package.json`) | uso existente em `boss.ts`/`enqueue.ts` (`schedule`, `send`, `key_strict_fifo`)                                          | 2026-10-18 | cron e envio com `singletonKey` já em produção na 3a                                        |
| pg-boss (`schedule`) | 12.35.0                  | tipos instalados `dist/index.d.ts` (`schedule(name, cron, data?, options?)`) e `types.d.ts` (`SendOptions.singletonKey`) | 2026-10-18 | `data` é opcional no `schedule`; `send` avulso com `singletonKey` na mesma fila é permitido |
| People API           | REST v1                  | plano 3a (sequencial por usuário, 429/backoff)                                                                           | 2026-10-16 | a varredura continua enfileirando 1 job por contato na fila serial por org                  |

## Escopo

- `packages/db/src/schema/external.ts`
- `packages/db/migrations/**`
- `packages/core/src/modules/contacts/**`
- `packages/core/src/modules/external-connections/**`
- `packages/automation/src/**`
- `apps/web/src/server/actions/contacts.ts`
- `apps/web/src/server/actions/external-connections.ts`
- `apps/web/src/server/actions/external-connections.test.ts`
- `apps/web/src/server/services.ts`
- `apps/web/src/app/app/settings/channels/**`
- `apps/web/src/app/app/contacts/**`
- `apps/web/src/components/contact-*`
- `apps/web/messages/pt-BR.json`
- `apps/web/e2e/**`

## Fora de escopo

- `batchCreateContacts` / `batchUpdateContacts` (decisão acima).
- Pull / bidirecional, propagação de deletes, fotos, campos custom, grupos.
- Gatilho a cada mensagem/ingest: contatos criados pelo ingest entram pela
  varredura, não por evento.
- Botão "Tentar de novo" dedicado: falhas voltam sozinhas pelo backoff de 1 h
  e "Sincronizar agora" cobre o resto.
- Sweep de jobs `failed` que seguram a chave da org (`shortcut` da 3a).
- Verificação do app no Google (fim do desenvolvimento).

## Tarefas

Detalhe, acceptance e verify em `tasks/todo.md`.

1. **Consentimento persistido** — migração `auto_sync_since` + `last_sweep_at`;
   serviço marca/lê; desconectar zera por apagar a linha. Teste de isolamento
   entre orgs.
2. **Sync grava a tentativa + consulta de pendentes** — `lastAttemptAt` em todo
   término; função SQL de contatos pendentes (elegibilidade espelhada, edição,
   backoff de erro) com teste de paridade contra `isEligible`.
3. **Varredura ponta a ponta** — fila + handler `contact-google-sweep`, cron
   de 10 min, e o botão "Sincronizar agora" passa a marcar o consentimento e
   enfileirar a varredura da org.
4. **Gatilho nas edições** — criar/editar contato na UI enfileira o sync
   (melhor esforço, nunca falha a edição) quando há consentimento.
5. **Card: resumo em SQL, falhas e última varredura** — uma consulta agregada,
   contador/faixa de falhas, data da última varredura, i18n, e2e.
6. **Higiene** — cliente People único por varredura/handler; dialog de edição
   sem `metadata.google`.
7. **Docs e fechamento** — spec, `TODO.md`, `docs/development` se tocar jobs.

Checkpoints: após a tarefa 3 (motor automático funcionando no staging com o
botão) e após a 5 (card completo, `verify:full`).

## Riscos

| Risco                                                                                    | Impacto | Mitigação                                                                                                    |
| ---------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| Backlog grande: o cron reenfileira contatos que ainda estão na fila                      | Média   | Job é idempotente (hash); cap por varredura; `shortcut:` documentado; revisitar se a fila crescer no staging |
| Pré-filtro SQL diverge de `isEligible`                                                   | Média   | Teste de paridade com casos de borda (`@lid`, e-mail em branco, 7/16 dígitos)                                |
| Erro permanente (ex.: dado recusado pelo Google) gera tentativa a cada hora, para sempre | Baixa   | Backoff de 1 h, contador visível no card; sem retry imediato                                                 |
| Migração em tabela com RLS                                                               | Baixa   | Só colunas nullable; checklist de RLS/grants do CLAUDE.md revisado; `verify:full`                            |
| Cron varre org com conexão `needs_reauth`                                                | Baixa   | Filtra `status = connected`; o sync já não faz nada sem token                                                |
| Edição enfileira e a fila está indisponível                                              | Baixa   | Melhor esforço + `captureException`; a varredura cobre depois                                                |

## Critérios de pronto

- [x] `pnpm verify` verde
- [x] `pnpm verify:full` verde (toca banco, job e UI)
- [x] Testes: paridade de elegibilidade, pendentes (nunca tentado / editado /
      erro com backoff), consentimento isolado por org, handler da varredura
      (cap, org sem consentimento ignorada), gatilho da edição, resumo SQL
- [x] Teste manual no staging: editar um contato sincroniza sozinho; criar
      contato pelo ingest aparece após a varredura; falha forçada mostra a
      faixa e o contador
- [x] Docs atualizadas: `docs/product/contacts-google-sync.md`
- [x] `TODO.md`: slice 3b concluída
