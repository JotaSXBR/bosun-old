# Todo — Dívida de testes e auditoria pós-lint

Plano: `tasks/plan.md`. PR A = tarefa 2 (branch `chore/audit-overrides`);
PR B = tarefas 1, 3, 4, 5 (branch `test/coverage-debt`). Um commit por tarefa.

## Task 1: Registrar a dívida no `TODO.md`

- [x] Itens P3 em Produto — backlog: boss.ts / findConversation / useRunAction+useOnOpen / drag do kanban / macro-picker; audio+voice (staging do usuário); design-system (repasse com Claude Design); avisos do audit
- **Acceptance**: cada item com prioridade e o motivo de estar fora desta rodada
- **Verify**: `pnpm format:check`
- **Deps**: nenhuma · **Tamanho**: XS

## Task 2: Overrides de `esbuild` e decisão sobre `braces` (PR A)

- [x] `pnpm why` confirma as cadeias; `overrides` em `pnpm-workspace.yaml` por faixa para `esbuild`
- [x] `braces`: confirmar se há versão corrigida; se não, documentar aceite
- **Acceptance**: `pnpm audit --prod` sem o `esbuild` (e sem `braces` se houver correção); `db:generate` ainda "No schema changes"
- **Verify**: `pnpm audit --prod` · `pnpm db:generate` · `pnpm verify:full` · CI
- **Deps**: nenhuma · **Tamanho**: S

## Task 3: Testes unitários baratos

- [x] `packages/automation/src/boss.test.ts` (pg-boss mockado): cada valor de `QUEUES` tem um `work()`; 5 crons esperados; handler recebe `job.data`
- [x] `apps/web/src/server/find-conversation.test.ts`: `NotFoundError` → `null`; outro erro relançado; sucesso devolve a linha
- **Acceptance**: testes novos passam e viram RED se a tabela/mapeamento for alterado
- **Verify**: `pnpm --filter @crm/automation test` · `pnpm --filter @crm/web test`
- **Deps**: nenhuma · **Tamanho**: S

## Task 4: Camada de teste de hooks no `web`

- [x] `jsdom` + `@testing-library/react` (versões compatíveis) em `apps/web` devDependencies
- [x] ambiente jsdom só nos arquivos que precisam (docblock ou projeto), sem afetar os testes node
- [x] `use-run-action.test.tsx`: `{ok:false}` → `toast.error`, sem `onSuccess`/refresh; `{ok:true}` → toast de sucesso, `onSuccess`, `router.refresh`
- [x] `use-on-open.test.tsx`: dispara uma vez por transição false→true; não na montagem aberta nem em re-render
- **Acceptance**: contagem de testes node inalterada; os novos passam; mutação (inverter a condição) vira RED
- **Verify**: `pnpm --filter @crm/web test` · `pnpm test` (suíte inteira, sem vazamento de `window`)
- **Deps**: nenhuma · **Tamanho**: M

## Task 5: e2e do kanban e do macro-picker

- [ ] `deals.spec.ts` (ou spec novo): arrastar um card para outra etapa persiste após reload; menu "Mover para" move
- [ ] spec do macro-picker: digitar `/` abre o picker e inserir uma macro preenche o campo
- **Acceptance**: specs estáveis (3 rodadas verdes seguidas), sem `waitForTimeout`
- **Verify**: `pnpm --filter @crm/web exec playwright test e2e/<arquivo> --reporter=line`
- **Deps**: nenhuma · **Tamanho**: M

### Checkpoint: fim

- [ ] `pnpm verify:full` verde nos dois PRs · CI verde · revisar com o humano
