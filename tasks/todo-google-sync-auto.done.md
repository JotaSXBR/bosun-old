# Todo — Google Contacts: sync automático (3b)

Plano: `tasks/plan.md`.

## Task 1: Consentimento persistido

- [x] Colunas nullable `external_connections.auto_sync_since` e
      `last_sweep_at` (schema + migração gerada e revisada)
- [x] Serviço: marcar o consentimento (idempotente, mantém a data original) e
      ler "auto-sync ativo" (`connected` + marcador)
- [x] Desconectar apaga a linha → consentimento some
- [x] Teste de integração: marcar na org A não habilita a org B
- **Acceptance**: sem marcador a org não aparece como elegível a sync
  automático; marcar duas vezes não muda a data
- **Verify**: `pnpm db:generate` (revisar SQL) · `pnpm db:migrate` ·
  `pnpm --filter @crm/core test:integration` do módulo
- **Deps**: nenhuma · **Tamanho**: S

## Task 2: Tentativa gravada + consulta de pendentes

- [x] `syncContactToGoogle` grava `lastAttemptAt` em todo término (criou,
      atualizou, `unchanged`, falhou) sem tocar `updated_at`; sucesso
      continua limpando `lastError`
- [x] Repositório: `listPendingGoogleSyncContacts(org, { after, limit })` em
      SQL — elegível (pré-filtro) E (nunca tentado OU `updated_at` >
      `coalesce(lastAttemptAt, lastSyncedAt)` OU `lastError` com tentativa > 1 h), ordenado por id
- [x] Teste de paridade: o pré-filtro SQL e `isEligible` concordam em
      `@c.us` (7/8/15/16 dígitos), `@lid`, visitante do site, e-mail em
      branco
- **Acceptance**: contato `unchanged` deixa de ser pendente; contato com erro
  recente não aparece, com erro antigo aparece; contato editado aparece
- **Verify**: `pnpm --filter @crm/core test` · integração
  `google-contact-sync.int.test.ts` e do repositório
- **Deps**: 1 · **Tamanho**: M

## Task 3: Varredura ponta a ponta

- [x] Confirmar no pg-boss 12.35.0 (tipos instalados) `schedule` sem payload +
      `send` avulso na mesma fila; registrar em "Fontes consultadas"
- [x] Fila `contact-google-sweep`, handler com `organizationId` opcional:
      lista orgs com auto-sync ativo, pagina os pendentes (cursor por id),
      `enqueueContactGoogleSync` por contato (cap por execução), grava
      `last_sweep_at`; erro de uma org não derruba as outras
- [x] `schedule` a cada 10 min em `boss.ts`
- [x] `syncGoogleContactsAction`: marca o consentimento e enfileira a
      varredura da org (remove o laço sequencial da requisição); mantém
      cooldown e permissão `integrations:manage`
- [x] Handler e ação testados (org sem consentimento ignorada; conexão
      `needs_reauth` ignorada; fila indisponível devolve erro claro)
- **Acceptance**: clicar no botão em staging sincroniza a base inteira sem
  segurar a requisição; o cron repete sem duplicar contatos no Google
- **Verify**: `pnpm --filter @crm/automation test` · `pnpm --filter
@crm/web test` · `pnpm verify`
- **Deps**: 1, 2 · **Tamanho**: M

### Checkpoint: após a tarefa 3

- [x] `pnpm verify` e integração verdes
- [x] Staging: botão + varredura sincronizam; segundo tick não cria duplicata
- [x] Revisar com o humano antes de seguir

## Task 4: Gatilho nas edições

- [x] `createContactAction` e `updateContactProfileAction`, após sucesso,
      enfileiram `contact-google-sync` quando o auto-sync está ativo
- [x] Melhor esforço: falha da fila vira `captureException`, a edição segue ok
- [x] Teste de ação: com consentimento enfileira; sem consentimento não;
      fila fora do ar não quebra a edição
- **Acceptance**: editar o cargo de um contato sincronizado atualiza o Google
  em segundos, sem clicar em nada
- **Verify**: `pnpm --filter @crm/web test`
- **Deps**: 1, 3 · **Tamanho**: S

## Task 5: Card — resumo em SQL, falhas e última varredura

- [x] Resumo em uma consulta agregada (elegíveis, sincronizados, falhas,
      última sincronização) no lugar da paginação de todos os contatos
- [x] `GoogleSyncView` ganha `failed` e `lastSweepAt`; faixa de aviso quando
      `failed > 0` e linha "última varredura"; textos em `pt-BR.json`
- [x] Teste de integração do resumo (mesma regra de elegibilidade) e e2e do
      card (`apps/web/e2e`)
- **Acceptance**: base com 2 falhas mostra "2 contatos com erro"; a página
  carrega com uma consulta, não com N páginas
- **Verify**: `pnpm --filter @crm/core test:integration` · `pnpm --filter
@crm/web exec playwright test e2e/<arquivo> --reporter=line`
- **Deps**: 2, 3 · **Tamanho**: M

### Checkpoint: após a tarefa 5

- [x] `pnpm verify:full` verde
- [x] Staging: editar contato, criar via ingest, forçar uma falha
- [x] Revisar com o humano antes de fechar

## Task 6: Higiene

- [x] Cliente People criado uma vez por varredura/handler e reaproveitado
- [x] Dialog de edição recebe só as chaves do perfil, não `metadata.google`
- **Acceptance**: `metadata.google` não aparece no payload enviado ao
  navegador; testes existentes seguem verdes
- **Verify**: `pnpm --filter @crm/web test` · `pnpm typecheck`
- **Deps**: 3 · **Tamanho**: S

## Task 7: Docs e fechamento

- [x] `docs/product/contacts-google-sync.md`: seção "Slice 3b — implemented"
      (consentimento, varredura, backoff, limites restantes)
- [x] `TODO.md`: slice 3b concluída; Calendar/Gmail seguem como próximos
- [x] `pnpm verify:full` · review (`code-review-and-quality`) · commit local
- **Deps**: 1–6 · **Tamanho**: XS
