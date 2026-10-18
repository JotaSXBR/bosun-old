# Todo — Zerar os warnings de ESLint

Plano: `tasks/plan.md`. Branch: `chore/lint-warnings`. Um commit por tarefa,
`chore(lint): ...`. Medir com `pnpm --filter <pkg> lint` (0 warnings da regra).

## Task 1: Regras triviais, todos os pacotes

- [x] `dot-notation` (core 12, ai 1), `prefer-includes` (1), `prefer-nullish-coalescing` (2), `no-unnecessary-condition` (2)
- [x] `non-nullable-type-assertion-style` (storage 8)
- [x] `no-empty-function` (~20: testes, showcase, mocks), `vitest/no-conditional-expect` (7)
- [x] `shadcn/no-inline-styles` (4), `shadcn/require-static-classes` (2)
- **Acceptance**: essas regras com 0 ocorrências em todos os pacotes; nenhuma mudança de comportamento
- **Verify**: `pnpm lint` (contagem das regras) · `pnpm typecheck` · `pnpm test`
- **Deps**: nenhuma · **Tamanho**: M (muitos arquivos, 1–3 linhas cada; dividir em 2 commits se passar de 5 pacotes)

## Task 2: Pacotes pequenos

- [x] `config` (4), `db` (2), `ai` (1 se sobrar), `storage`, `auth` (15), `channels` (17)
- **Acceptance**: `pnpm --filter @crm/{config,db,ai,storage,auth,channels} lint` sem warnings
- **Verify**: lint + testes (e integração) de cada pacote tocado
- **Deps**: 1 · **Tamanho**: M

## Task 3: `automation`

- [x] 22 warnings (`max-statements`, `max-lines-per-function`, `max-params`) nos handlers
- **Acceptance**: `pnpm --filter @crm/automation lint` limpo; testes dos handlers inalterados
- **Verify**: `pnpm --filter @crm/automation test` · integração dos jobs tocados
- **Deps**: 1 · **Tamanho**: M

### Checkpoint: após a tarefa 3

- [ ] `pnpm verify` verde · revisar o diff com o humano

## Task 4: `core` — `max-params`

- [ ] 56 em src + 4 em testes: objeto de opções nas assinaturas; chamadores atualizados (web, automation, testes)
- [ ] Fatiar por módulo (≈100 linhas/commit)
- **Acceptance**: 0 `max-params` em `@crm/core`; `pnpm typecheck` do monorepo verde
- **Verify**: `pnpm typecheck` · `pnpm --filter @crm/core test` · integração dos módulos tocados
- **Deps**: 3 · **Tamanho**: L (dividir em commits por módulo)

## Task 5: `core` — `max-statements`, `max-lines-per-function`, `cognitive-complexity`

- [ ] Extrair passos nomeados sem reordenar efeitos (transações, enqueue, auditoria)
- **Acceptance**: 0 dessas regras em `@crm/core`
- **Verify**: `pnpm --filter @crm/core test` + integração; revisão atenta do diff em `withTenant`
- **Deps**: 4 · **Tamanho**: L

## Task 6: `core` — `max-lines`

- [ ] 6 arquivos de produção e 10 de teste divididos por assunto; mesma contagem de casos
- **Acceptance**: 0 `max-lines` em `@crm/core`; nº de testes igual
- **Verify**: contagem do vitest antes/depois · `pnpm --filter @crm/core test`
- **Deps**: 5 · **Tamanho**: M

### Checkpoint: após a tarefa 6

- [ ] `pnpm verify:full` verde · `@crm/core` limpo · revisar com o humano

## Task 7: `design-system`

- [x] 38 warnings (componentes e showcase: `max-lines-per-function`, `max-params`, `no-empty-function`, testes de tokens)
- **Acceptance**: `pnpm --filter @crm/design-system lint` limpo; `tokens.test.ts` inalterado em cobertura
- **Verify**: lint · testes do design-system · typecheck do web (consome os componentes)
- **Deps**: 1 · **Tamanho**: M

## Task 8: `web` — `max-statements`

- [ ] ≈53 em actions, route handlers e componentes: extrair helpers nomeados
- **Acceptance**: 0 `max-statements` em `@crm/web`
- **Verify**: `pnpm --filter @crm/web test` · typecheck · e2e dos fluxos tocados (Playwright, só texto de pass/fail)
- **Deps**: 4 · **Tamanho**: L (fatiar por área: actions, api, components)

## Task 9: `web` — `max-lines-per-function`, `max-lines`, `cognitive-complexity`

- [ ] ≈80: dividir componentes e arquivos por responsabilidade; mesmo markup/estilos
- **Acceptance**: `pnpm --filter @crm/web lint` limpo
- **Verify**: lint · testes · e2e dos fluxos tocados; sem mudar classes de design-system
- **Deps**: 8 · **Tamanho**: L

### Checkpoint: após a tarefa 9

- [ ] `pnpm lint` 0 warnings no monorepo · `pnpm verify` verde · revisar com o humano

## Task 10: Promover a `error` e fechar

- [ ] `tooling/eslint/base.js`: regras zeradas `warn` → `error`
- [ ] `docs/development/code-quality-standard.md` §2.3 e `TODO.md` atualizados
- **Acceptance**: reintroduzir uma violação quebra o lint
- **Verify**: `pnpm verify:full` · commit local, PR só a pedido
- **Deps**: 1–9 · **Tamanho**: S
