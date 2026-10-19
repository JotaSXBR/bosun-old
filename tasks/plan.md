# Plan — Fechar a dívida de testes e de auditoria pós-lint

- **Origem**: `TODO.md` (a registrar na tarefa 1) · resultado do `/ship` do PR #52 (test-engineer + security-auditor)
- **Lifecycle**: plan → build → test → review → ship
- **Data**: 2026-10-19

## Objetivo

Os gaps de teste e os 3 avisos de `pnpm audit --prod` deixados pelo PR #52
ficam registrados, e os que valem o custo são fechados: dependências sem
aviso evitável e cobertura direta do que a refatoração tocou.

## Contexto

Decisões do usuário (2026-10-19):

- Ordem: registrar no `TODO.md` → bump de dependências → testes unitários
  baratos → testes de hooks (pode adicionar `jsdom` e
  `@testing-library/react` como devDependencies do `web`) → e2e.
- **Audio e voice ficam de fora** (o usuário testa no staging).
- **Design-system fora**: o usuário vai repassá-lo com o Claude Design.
- Dois PRs: (A) só dependências (`overrides`), (B) registro + testes. Push e
  PR só quando o usuário pedir; ele já autorizou PR e merge no PR #52, e a
  autorização para estes dois PRs é pedida de novo no fim.
- Cadeias do audit (`pnpm why`): `braces` vem de
  `tooling/eslint > eslint-config-next > @next/eslint-plugin-next >
fast-glob > micromatch` (lint, dev); `esbuild` vem de
  `better-auth > drizzle-kit > @esbuild-kit/*` e `better-auth > vitest > vite`
  (ferramentas de dev). Nada no caminho de requisição em produção — o aviso
  só aparece em `--prod` porque `better-auth` é dependência.
- `braces` está marcado como "sem versão corrigida" pelo auditor: a tarefa 2
  confirma isso e, se for verdade, documenta o aceite em vez de forçar versão.

## Fontes consultadas

| Tema                       | Versão / alvo                       | Fonte                                                                     | Data       | O que confirmou                                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------- | ------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overrides` no pnpm        | pnpm 12.8.1 (`packageManager`)      | Context7 `/pnpm/pnpm.io` (settings/dependency-resolution)                 | 2026-10-19 | `overrides` vive em `pnpm-workspace.yaml`, só na raiz; `"pkg@faixa": "versão"` escopa por faixa; `"a>b"` escopa por pai                                                                                                                                 |
| Ambiente jsdom por arquivo | vitest 5.0.3                        | Context7 `/vitest-dev/vitest/v5.0.3` (config/environment, guide/projects) | 2026-10-19 | `// @vitest-environment jsdom` por arquivo, ou `test.projects` com `environment` por glob. `isolate: false` de `vitest.unit.shared.ts` verificado no build (suíte da raiz estável em 2 rodadas); o runner da raiz precisou incluir `apps/**/*.test.tsx` |
| `@testing-library/react`   | a confirmar contra o React do `web` | a consultar antes da tarefa 4                                             | —          | versão compatível com a do React e do vitest 5                                                                                                                                                                                                          |
| Advisories do audit        | `pnpm audit --prod`                 | execução local                                                            | 2026-10-19 | 1 high (`braces`), 1 moderate + 1 low (`esbuild`), todos transitivos de ferramentas de dev                                                                                                                                                              |

## Escopo

TODO.md
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
vitest.config.ts
vitest.unit.shared.ts
apps/web/package.json
apps/web/vitest.config.ts
apps/web/src/**
apps/web/e2e/**
packages/automation/src/**
packages/core/src/**

## Fora de escopo

- Audio-player e voice-recorder (staging do usuário).
- Design-system (repasse com o Claude Design).
- Mudança de comportamento de produto: se um teste achar bug, corrige-se só
  se for trivial e isolado; senão vira item no `TODO.md`.
- Upgrade de major de `eslint-config-next`, `drizzle-kit` ou `vitest` só para
  limpar aviso.

## Tarefas

Detalhe, acceptance e verify em `tasks/todo.md`.

1. Registrar a dívida no `TODO.md`.
2. Overrides de `esbuild` (e decisão sobre `braces`) — **PR A**.
3. Testes unitários: `boss.ts` e `findConversation` — PR B.
4. Camada de teste de hooks no `web` + `useRunAction`/`useOnOpen` — PR B.
5. e2e: arrastar card no kanban e macro-picker — PR B.

## Riscos

| Risco                                                                                       | Impacto | Mitigação                                                                              |
| ------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| Override de `esbuild` quebra `drizzle-kit`/`tsx`/vite (majors diferentes: 0.18, 0.25, 0.27) | Média   | override por faixa, rodar `db:generate`, `verify:full` e CI; reverter se quebrar       |
| `isolate: false` + jsdom vaza `window` para testes node                                     | Média   | ambiente por arquivo/projeto; rodar a suíte inteira e comparar a contagem antes/depois |
| Teste de drag no kanban flaky                                                               | Média   | `page.mouse` com passos explícitos e `expect.poll`; sem `waitForTimeout`               |
| `braces` sem correção                                                                       | Baixa   | documentar aceite (dev-only) no `TODO.md`, sem forçar versão                           |

## Critérios de pronto

- [ ] `pnpm verify:full` verde em cada PR; CI verde
- [ ] `pnpm audit --prod`: só o que for inevitável, com justificativa registrada
- [ ] Nº de testes sobe; nenhum teste removido, pulado ou enfraquecido
- [ ] `TODO.md`: itens novos registrados e os fechados movidos para Concluído
