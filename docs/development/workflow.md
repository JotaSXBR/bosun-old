# Development workflow

How work flows in this repo — human + Claude Code. The lifecycle uses the
`agent-skills` plugin (`addyosmani/agent-skills`, marketplace
`addy-agent-skills`, declared in `.claude/settings.json`; install with
`/plugin marketplace add addyosmani/agent-skills` then
`/plugin install agent-skills@addy-agent-skills`). It provides the skills,
the phase commands (`/spec`, `/plan`, `/build`, `/test`, `/review`, `/ship`,
`/webperf`, `/code-simplify`) and the reviewer personas — there are no
project-local alias skills. The repo's own rules (plan template, scope
contract, gates, commit policy) live here and in `CLAUDE.md`.

## The loop

```
spec  →  plan  →  build  →  test  →  review  →  ship
```

Mesma sequência do pack upstream, cada fase carregando as skills da tabela
abaixo. Adaptações locais:

- **spec** (`spec-driven-development`) escreve/edita o PRD em
  `docs/product/` (o formato do projeto, não `SPEC.md` na raiz); quando o
  item já é coberto por um doc, o spec pode ser pulado — ver "Quando o spec
  é obrigatório".
- **plan** (`planning-and-task-breakdown`) escreve `tasks/plan.md` seguindo
  `docs/development/plan.template.md`, que **também carrega o contrato de
  escopo** (`## Escopo` globs) que o hook enforça — o plano é o contrato;
  sem `## Escopo` o hook não trava. Não existe passo de "brief" separado.
- **test** é o gate `pnpm verify` (ver "Gates de qualidade").
- **commit**: local, por tarefa verificada (`pnpm verify` verde), atômico e em
  Conventional Commits numa feature branch; push/PR só quando o usuário pedir.

Skills por fase (espelha `skills.addy.ie/lifecycle`): cada comando carrega
o **conjunto da fase** — as "sempre" definem o método da fase; as
condicionais se aplicam quando o trabalho toca o eixo delas.

| Stage  | Comando | Skills — sempre                                                                                                                                               | Skills — quando o eixo se aplica                                                                                                                                                                                                                                          |
| ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec   | —       | `spec-driven-development` (PRD em `docs/product/`; ver "Quando o spec é obrigatório")                                                                         | `interview-me`, `idea-refine` — ideia crua/ambígua                                                                                                                                                                                                                        |
| Plan   | —       | `planning-and-task-breakdown` → `tasks/plan.md` (template: `docs/development/plan.template.md`; carrega `## Contexto` + `## Escopo`) + gate de esclarecimento | —                                                                                                                                                                                                                                                                         |
| Build  | —       | `incremental-implementation` (slices finos), `test-driven-development` (teste junto)                                                                          | `frontend-ui-engineering` (UI), `api-and-interface-design` (contratos novos), `source-driven-development` + `context7-mcp` (API de lib/framework — checar docs oficiais), `doubt-driven-development` (decisão arriscada), `context-engineering` (setup de contexto/rules) |
| Test   | —       | `debugging-and-error-recovery` (triage de falha)                                                                                                              | evidência real no browser via spec Playwright (`apps/web/e2e`, `--reporter=line`) quando há UI/fluxo — sem MCP de browser (ver `CLAUDE.md`); `browser-testing-with-devtools` só para debug ao vivo                                                                        |
| Review | —       | `code-review-and-quality` (diff review antes de commit) + checklist UX das 7 leis (`docs/development/ux-7-leis-checklist.md`) para telas novas/alteradas      | `code-simplification` (complexidade acumulada), `security-and-hardening` (auth/webhooks/dados/deps), `performance-optimization` (queries, N+1, bundle)                                                                                                                    |
| Ship   | —       | `git-workflow-and-versioning` (commit convencional local por tarefa verificada; push/PR só a pedido), `shipping-and-launch` (checklist/rollback)              | `ci-cd-and-automation` (pipeline), `documentation-and-adrs` (docs/ADR), `observability-and-instrumentation` (logs/métricas), `deprecation-and-migration` (remoções/migrações)                                                                                             |

Standalone fora do loop principal: `performance-optimization` (audit —
achados em `docs/audits/perf-<escopo>-<data>.md`) e `code-simplification`
(rodada de simplificação).

Skills fora de fase (upstream, standalone): `using-agent-skills`
(meta — roteamento de skill) e `constraint-driven-development` (barra
de qualidade como contrato escrito; invocar quando o projeto não tem
padrões escritos ou agentes silenciam checks pra chegar no verde).

Docs de libs: MCP `context7` + skill global `context7-mcp`
(companheira de `source-driven-development` no Build).

Fonte de verdade do pack: `github.com/addyosmani/agent-skills` — clone
de referência em `research/agent-skills` (gitignored, re-cloneable).

## Gate de esclarecimento (antes do plan, sempre)

Trabalho não-trivial **começa com perguntas, não com código**. Mudança feita
sobre suposição é a definição de risco (CRAP: complexo × sem cobertura de
entendimento). Regra:

- Antes de escrever o plan, o agente identifica ambiguidades que afetam
  **escopo ou arquitetura** e pergunta ao usuário (menu de múltipla escolha
  com opção de texto livre — `AskUserQuestion`).
- Pergunta só o que muda decisão — preferências cosméticas seguem o default
  documentado e são registradas no plan como decisões provisórias.
- As respostas entram no `## Contexto` do `tasks/plan.md` — fica o registro
  do porquê, não só do quê.
- Pedido já claro e fechado ("rode X", "corrija o typo em Y") não exige
  gate — usar julgamento. Na dúvida, perguntar: uma pergunta é mais barata
  que um retrabalho.
- `interview-me` e `spec-driven-development` são as skills para quando a
  ambiguidade é de produto, não de implementação.

## Gate de documentação (plan e build)

Memória não é fonte: o que sabemos de biblioteca ou API pode estar defasado
(ex.: o `pg-boss` 12 ganhou a política `key_strict_fifo`, que muda o desenho
de uma fila). A skill `source-driven-development` (detectar versão → buscar →
implementar → citar) vale **em dois momentos**:

1. **No plan** — toda decisão que molda escopo ou arquitetura e depende de
   biblioteca/API externa entra na seção `## Fontes consultadas` do
   `tasks/plan.md` (tema, versão, fonte, data, o que confirmou).
2. **No build** — antes da primeira linha de uma tarefa que toca uma API
   externa ainda não listada, a linha nova entra na tabela primeiro.

Fontes, em ordem: Context7 MCP para bibliotecas (`resolve-library-id` →
`query-docs`); documentação oficial buscada por HTTP para APIs REST de
provedores (Google, Meta etc.); e, se o Context7 falhar, os tipos/README do
próprio pacote instalado (`node_modules`). O que não for encontrado é
marcado como **NÃO VERIFICADO**. Falha de ferramenta (chave inválida do
Context7, por exemplo) é dita em voz alta; nunca se volta calado para a
memória.

## Quando o spec é obrigatório

Todo item entra pelo plan — o que varia é se antes disso um spec
precisa ser escrito:

- **Spec obrigatório** (PRD em `docs/product/` via
  `spec-driven-development`): feature nova com comportamento visível ao
  usuário, item do TODO sem decisões registradas, ou qualquer ambiguidade
  de produto que o gate de esclarecimento não resolve em 1-2 perguntas.
- **Spec pode ser pulado** (vai direto ao plan, que ainda
  registra as decisões no `## Contexto`): chore/hardening já especificado — findings de
  review com decisões tomadas, itens do TODO com decisão datada, fixes
  mecânicos — e todo item já coberto por um doc em `docs/product/`.

Regra prática: se a pergunta "o que deve existir quando isso terminar?" não
tem resposta de uma frase já escrita em algum lugar, o spec primeiro.

## A trava de escopo (`tasks/plan.md` + hooks)

`.claude/settings.json` → `.claude/hooks/workflow.mjs` registra:

- **SessionStart**: injeta o resumo deste workflow no contexto.
- **PreToolUse** (edit/write): **nega** (`permissionDecision: deny`) editar arquivo de código/config
  fora dos globs de `## Escopo` do `tasks/plan.md`. Markdown/docs são
  sempre livres. Sem plan → só lembrete (edições pontuais/docs não travam).
  Limites conhecidos: só intercepta `Edit`/`Write`/`NotebookEdit` —
  comandos de shell (`Bash`) não passam pelo hook; `.claude/**` e `**/*.md`
  ficam sempre livres aqui, mas `AGENTS.md`, `CLAUDE.md`, `.claude/**` e
  `.github/**` estão sob `ask` em `.claude/settings.json`.
  O hook é um lembrete com trava, não uma fronteira de segurança —
  a camada real é `.claude/settings.json` + permissões da sessão.
- **PostToolUse**: marca que a sessão editou código/config (docs e `.md` não
  contam — sessões só de docs não disparam o gate).
- **Stop**: se a sessão editou, **bloqueia a primeira tentativa de parar**
  exigindo o gate — `pnpm verify` + TODO/docs atualizados. Bloqueia uma
  vez por sessão (não faz loop).
- **SessionEnd**: limpa o marcador.

Para expandir escopo no meio do trabalho: edite o `## Escopo` do plan
(o agente pergunta antes) — a trava cede, o registro fica.

Um plan ativo por vez. Concluído → arquivar como
`tasks/plan-<item>.done.md` (junto do `tasks/todo-<item>.done.md`).
Briefs históricos da era `.task-brief.md` estão arquivados em
`tasks/briefs/`.

## Gates de qualidade (o que "verde" significa)

Fonte única: os scripts `verify`/`verify:full` do `package.json` raiz —
toda referência a gate aponta para eles.

- **`pnpm verify`** — `format:check` + `lint` + `typecheck` + `test`
  (unit). Obrigatório ao fim de qualquer sessão com edição.
- **`pnpm verify:full`** — `verify` + `test:integration` + `test:e2e` +
  `build`. Antes de merge e para mudanças que tocam DB/providers.
- Iterando, o atalho é `pnpm --filter @crm/<pkg> test` + `typecheck`/`lint`.
- Nunca usar `pnpm format` (mutante) como verificação — só `format:check`.

O CI continua sendo a barreira final (roda os mesmos cheques via turbo).

## MCP servers do projeto

`.mcp.json` (commitado, escopo do projeto): **codegraph**.

- **coolify** (http) — painel de deploy; URL real e token ficam fora do
  repo, no escopo local do Claude Code (`claude mcp add --scope local
--transport http coolify <url> --header "Authorization: Bearer …"`).
  Uso restrito a leitura + deploy/start/stop/restart; tools cobertas por
  `ask` em `.claude/settings.json` — configurações fora disso (envs, fqdn,
  healthcheck) escalam ao usuário (ver `deployment-coolify.md`).
- **chrome-devtools** — não configurado por ora; a skill
  `browser-testing-with-devtools` só funciona se for adicionado.

Servidor user-level conhecido: `context7` (docs de libs). Qualquer outro
(github etc.) só vale se configurado na máquina — não é garantido.

### Atualizando as skills

`.claude/skills/` tem só os aliases do ciclo (`spec`, `plan-task`, `build`,
`test`, `review`, `ship`, `code-simplify`, `webperf`). As 25 skills
vendorizadas de `addyosmani/agent-skills` vêm da instalação global
(`~/.agents/skills`, via `npx skills`); `skills-lock.json` registra a
fonte/hash esperados. Atualizar o pack é decisão própria, nunca no meio de
outro trabalho.

## O que NÃO muda

- AGENTS.md continua a fonte de verdade de regras de código/segurança.
- Commit local por tarefa verificada; push/PR só a pedido. Sem `apps/worker` sem ADR.
- Sem infra/dependências novas sem justificativa concreta.
- Secrets só via env — nunca em `.mcp.json` (usar o escopo
  local do `claude mcp add`).
