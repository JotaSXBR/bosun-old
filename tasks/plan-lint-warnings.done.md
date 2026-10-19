# Plan — Zerar os warnings de ESLint

- **Origem**: `TODO.md` → P2 "Zerar os warnings de lint" e P3 "Promover warns a error" · `docs/development/code-quality-standard.md` §2.3
- **Lifecycle**: plan → build (por fatia) → test → review → ship
- **Data**: 2026-10-18

## Objetivo

`pnpm lint` termina com **0 erros e 0 warnings** em todos os pacotes, sem
mudar comportamento, e as regras de tamanho/estrutura passam a `error` para
não voltarem.

## Contexto

Decisões do gate de esclarecimento (2026-10-18):

- **Refatorar de verdade**: `max-statements`, `max-params`,
  `max-lines-per-function`, `max-lines` e `sonarjs/cognitive-complexity` são
  resolvidos extraindo funções/módulos e agrupando parâmetros em objeto — não
  por `eslint-disable`, nem subindo limite. Se uma exceção por pasta for
  inevitável (ex.: showcase do design-system), vira override em
  `tooling/eslint/*` **com justificativa em `code-quality-standard.md`**, e é a
  exceção, não o caminho.
- **Fatiamento**: regras triviais primeiro (todos os pacotes), depois um
  pacote por vez, ≈100 linhas alteradas por commit, **nunca misturado com
  feature**. Um commit por fatia verificada, na branch `chore/lint-warnings`.
- **Sem mudança de comportamento**: os testes existentes são a rede de
  segurança; nenhum teste é apagado, pulado ou enfraquecido para zerar um
  warning. Refatorações de assinatura (`max-params`) atualizam todos os
  chamadores no mesmo commit.
- **Medição de 2026-10-18** (warnings por pacote, 0 erros): web ~150, core
  ~128, design-system 38, automation 22, channels 17, auth 15, storage 8,
  config 4, db 2, ai 1 (≈385; o TODO de 2026-10-15 media 337). Por regra:
  `max-params` ~70 (core 56 em código de produção, 4 em teste), `max-statements`
  ~103, `max-lines-per-function` ~118, `max-lines` ~28 (core: 6 em src, 10
  em testes), `no-empty-function` ~20, `dot-notation` 13,
  `non-nullable-type-assertion-style` 8, `vitest/no-conditional-expect` 7,
  `cognitive-complexity` 5, `no-inline-styles` 4 e as de 1–2 ocorrências
  (`prefer-nullish-coalescing`, `prefer-includes`, `no-unnecessary-condition`,
  `require-static-classes`).
- **Promoção a `error`** só quando a contagem da regra zerar em todos os
  pacotes (regra do standard §2.3).

## Fontes consultadas

Nenhuma biblioteca/API externa nova: o trabalho só aplica regras já
configuradas em `tooling/eslint/base.js`.

| Tema                    | Versão / alvo                 | Fonte                                                                           | Data       | O que confirmou                                                                                                                 |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Regras e limites atuais | ESLint 9.39 flat config       | `tooling/eslint/base.js`, `docs/development/code-quality-standard.md` §1.3/§2.3 | 2026-10-18 | limites: `max-params` 3, `max-statements` 10, `max-lines-per-function` 50, `max-lines` 300, cognitive 15; promoção quando zerar |
| Contagem de warnings    | `eslint . -f json` por pacote | execução local                                                                  | 2026-10-18 | números acima                                                                                                                   |

## Escopo

- `packages/*/src/**`
- `apps/web/src/**`
- `apps/web/e2e/**`
- `design-system/src/**`
- `tooling/eslint/**`
- `eslint.config.js`
- `docs/development/code-quality-standard.md`

## Fora de escopo

- Qualquer mudança de comportamento, feature ou correção de bug (um bug
  achado no caminho vira item no `TODO.md`, não entra na fatia).
- Novas dependências, novos plugins ou novas regras.
- Migrações de banco.
- `tooling/eslint/*` além de promover severidade e, se inevitável, um
  override documentado.

## Tarefas

Detalhe, acceptance e verify em `tasks/todo.md`.

1. **Regras triviais, todos os pacotes** — `dot-notation`, `prefer-includes`,
   `prefer-nullish-coalescing`, `no-unnecessary-condition`,
   `non-nullable-type-assertion-style`, `no-empty-function`,
   `vitest/no-conditional-expect`, `no-inline-styles`, `require-static-classes`
   (≈70 ocorrências, mudanças de 1–3 linhas).
2. **Pacotes pequenos** — `config`, `db`, `ai`, `storage`, `auth`, `channels`.
3. **`automation`** — 22 warnings (handlers com muitas instruções).
4. **`core`, parte A: `max-params`** (56 em src) — objeto de opções nas
   assinaturas, chamadores atualizados.
5. **`core`, parte B: `max-statements`, `max-lines-per-function`,
   `cognitive-complexity`** — extrair passos nomeados.
6. **`core`, parte C: `max-lines`** (6 src + 10 testes) — dividir módulos e
   arquivos de teste por assunto, sem alterar casos.
7. **`design-system`** — 38 warnings (componentes e showcase).
8. **`web`, parte A: `max-statements`** (≈53).
9. **`web`, parte B: `max-lines-per-function`, `max-lines`,
   `cognitive-complexity`** (≈80).
10. **Promoção a `error` + docs** — regras zeradas viram `error` em
    `tooling/eslint/base.js`; `code-quality-standard.md` §2.3 e `TODO.md`
    atualizados; `pnpm verify:full`.

Checkpoints: após a tarefa 3 (pacotes de menor risco), após a 6 (`core`
inteiro) e após a 9 (todos os pacotes), cada um com `pnpm verify`.

## Riscos

| Risco                                                                   | Impacto | Mitigação                                                                                                               |
| ----------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| Refatoração de assinatura (`max-params`) quebra chamador fora do pacote | Média   | typecheck do monorepo (`pnpm typecheck`) a cada fatia; mudar assinatura e chamadores no mesmo commit                    |
| Extrair função muda ordem de efeitos (transação, enqueue)               | Alta    | só mover código sem reordenar; testes de integração do módulo na fatia; revisar o diff de `withTenant`/jobs com atenção |
| Dividir arquivo de teste perde caso ou fixture compartilhada            | Média   | comparar a contagem de testes antes/depois (`vitest` reporta)                                                           |
| Tentação de silenciar com `eslint-disable` ou subir limite              | Média   | `constraint-driven-development`: nenhum `eslint-disable` novo; override só com justificativa no standard                |
| Fatias grandes demais                                                   | Média   | ≈100 linhas por commit; quebrar a tarefa se passar de 5 arquivos                                                        |
| Conflito com trabalho de feature em paralelo                            | Baixa   | branch curta, fatias pequenas, rebase frequente                                                                         |

## Critérios de pronto

- [ ] `pnpm lint` com 0 erros e 0 warnings em todos os pacotes
- [ ] `pnpm verify` verde a cada fatia; `pnpm verify:full` verde no fim
- [ ] Nº de testes igual ou maior que antes; nenhum teste removido, pulado ou enfraquecido
- [ ] Nenhum `eslint-disable` novo; overrides, se houver, justificados no standard
- [ ] Regras zeradas promovidas a `error` em `tooling/eslint/base.js`
- [ ] Docs atualizadas: `docs/development/code-quality-standard.md` §2.3
- [ ] `TODO.md`: itens "Zerar os warnings" e "Promover warns a error" movidos para concluído
