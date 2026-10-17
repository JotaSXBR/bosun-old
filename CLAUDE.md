# CLAUDE.md

Guidance for Claude Code (and `AGENTS.md`-aware tools, which import this file) and contributors working on this repo.

## What this is

**Bosun** — multi-tenant customer operations platform (SaaS CRM). A
**modular monolith**: one Next.js app + pg-boss background jobs in-process +
shared `@crm/*` packages. pnpm/Turborepo monorepo.
Repo: `github.com/JotaSXBR/bosun` (public, Apache-2.0).

## Working agreement

- **State assumptions before coding.** Pick an interpretation explicitly —
  or ask when genuinely ambiguous.
- **Simplest sufficient solution.** No speculative features, abstractions
  for single-use code, or unrequested configurability.
- **Surgical diffs.** Touch only what the change requires; don't refactor
  or reformat adjacent code.
- **Goal-driven execution.** Reproduce → fix → verify. Before finishing,
  run `pnpm verify` and report it (`pnpm --filter @crm/<pkg> test` +
  `pnpm typecheck`/`pnpm lint` while iterating).
- **Delegate mechanical work.** Fan out mechanical edits/exploration to
  subagents when the user asks; keep planning and review in the main session.
- **Commit locally per verified task; push and PRs only on explicit user
  request.** Follow `incremental-implementation` /
  `git-workflow-and-versioning`: once a plan task is done and `pnpm verify`
  is green, make one atomic Conventional Commit on a feature branch (never
  directly on `main`). Don't mix tooling/refactor with feature changes in
  one commit. Never `git push`, open a PR or amend/force-push unprompted.

## Architecture & layering

```
UI (React) → Server Action / Route Handler → @crm/core service → repository → Postgres
```

`apps/web` (Next.js 16) · `packages/core` (domain) · `packages/db` (Drizzle,
`withTenant`) · `packages/{auth,permissions,config,observability}` ·
`packages/{channels,billing,storage,email,ai}` (providers — adapters only in
`src/adapters/*`) · `packages/automation` (pg-boss in-process) ·
`design-system/` (`@crm/design-system`) · `tooling/*` · `research/` (gitignored
reference, never import).

Dependency direction: app → core/providers → db/config/permissions. Never
import an adapter outside its registry factory. The only `switch` on provider
kind is each package's `create*Provider`. Detail: `docs/architecture/`.

## Development workflow

Lifecycle, using the global agent-skills (no project-local skills):
`spec-driven-development` (PRD in `docs/product/*`) →
`planning-and-task-breakdown` → `incremental-implementation` +
`test-driven-development` → `pnpm verify` → `code-review-and-quality` →
`git-workflow-and-versioning` (local commit per verified task). `tasks/plan.md`
doubles as the scope contract (`## Escopo` globs) enforced by
`.claude/hooks/` — full rules and the hook's limits in
`docs/development/workflow.md`.
Never hand-write `tasks/plan.md` — ask the clarifying questions first
(`AskUserQuestion`), then use `planning-and-task-breakdown` following
`docs/development/plan.template.md`; the plan must carry `## Contexto` and
`## Escopo` or the hook won't gate. Pre-plan skills as needed:
`interview-me` when the ask is underspecified, `idea-refine` to stress-test
a vague idea, `doubt-driven-development` for high-stakes calls.

**Docs before code — memory is not a source.** Any decision that depends on
an external library, framework, CLI or provider API must be grounded in
current docs for the version in use (`package.json`), via
`source-driven-development` (detect version → fetch → implement → cite):
Context7 MCP (`resolve-library-id` → `query-docs`) for libraries, the
official docs fetched over HTTP for provider REST APIs, or the installed
package's own types/README when Context7 is unavailable. It happens twice:
(1) **at plan time**, for every decision that shapes scope or architecture —
recorded in the plan's `## Fontes consultadas` (theme, version, source, date,
what it confirmed); (2) **at build time**, before the first line of a task
that touches an external API not yet listed there — add the row first. What
cannot be found is flagged UNVERIFIED, never assumed. If Context7 fails
(e.g. invalid key), say so out loud and use the fallback above; never drop
silently to memory.

## Commands

`pnpm install` · `dev` · `build` · `verify` (gate: format:check+lint+
typecheck+test) · `verify:full` (+integration+e2e+build) · `test` (unit) ·
`test:integration` (needs infra) · `test:e2e` · `infra:up|down` ·
`db:generate|migrate|seed|studio` · `storage:init`. Jobs (pg-boss) start with
`pnpm dev` — nothing separate. `pnpm install` installs the lefthook
pre-commit (prettier on staged).

## Code rules

- Strict TypeScript, **no `any`**, no speculative abstractions.
- Zod-validate every external payload (webhooks, provider responses, action
  inputs).
- Server Actions return `{ ok: true, ... } | { ok: false, error: string }`;
  never throw raw errors to the client.
- Explicit, readable code; imports only via each module's index exports.
- Postgres error inspection goes through `@crm/core` `src/lib/pg-error.ts`
  (`isUniqueViolation`/`isForeignKeyViolation`/`isPgError`,
  `translatePgErrors`, typed `PgError`s) — drizzle wraps driver errors on
  `cause`, so never read `.code`/`.constraint_name`/cause-chains at call
  sites (lint-enforced in `packages/core`).

## Design system

- `DESIGN.md` is the visual contract and **source of truth for tokens** —
  read it before UI work; token changes start there, then
  `design-system/src/styles/tokens/*.css` (`tokens.test.ts` fails on drift).
- New UI comes from `design-system/` (`@crm/design-system/{components,templates}/<name>`).
  Never hardcode color, font, font size, spacing, radius or shadow — only the
  token-mapped Tailwind vocabulary (`bg-surface`, `text-ink-muted`,
  `border-line`, `rounded-card`, `shadow-pop`… — DESIGN.md → Implementation).
  Lint enforces it.
- Map/usage: `design-system/README.md` + `COMPONENTS.md`; showcase:
  `/design-system` (dev). Copy is pt-BR "você", sentence case, no emoji; no
  logo exists — use `<Wordmark />`. Dark-only app (`data-theme="dark"`).

## Database & migrations

1. Edit `packages/db/src/schema/*` → `pnpm db:generate` → review SQL →
   `pnpm db:migrate`.
2. Never edit an already-applied migration; RLS policies and grants are done
   via custom migrations (see `packages/db/migrations`).
3. New tenant-owned table checklist: `organization_id` column + `pgPolicy` on
   `app.organization_id` + `.enableRLS()` + `FORCE ROW LEVEL SECURITY` +
   migration granting to `crm_app` + integration test proving cross-org
   isolation.

## Security rules (non-negotiable)

- Tenant isolation is application-layer primary + Postgres RLS as
  defense-in-depth. **Never accept `organizationId` from the client** — it
  comes from the session's active organization.
- `withPlatformScope` only after a platform-admin check.
- Webhooks: `verifyWebhook` on the raw body BEFORE parsing. Provider secrets
  live in env only.
- No secrets/PII in logs; logger redacts token/secret/password keys anyway.
- AI agents reach capabilities only through permissioned tools — never a DB
  handle.
- Uploads only via `tenantObjectKey(organizationId, ...)`.
- Errors in domain/packages go through `captureException` — never Sentry
  directly.

## Running locally

`pnpm install` → `cp .env.example .env` → `pnpm infra:up` → `pnpm db:migrate`
→ `pnpm db:seed` → `pnpm storage:init` → `pnpm dev` (http://localhost:3000;
seed logins `Password123!`, see `docs/development/getting-started.md`).

## Testing & docs map

Unit `*.test.ts` · integration `*.int.test.ts` (real Postgres/RustFS) ·
e2e `apps/web/e2e/*.spec.ts` (playwright) · fakes in each package's `testing`
export. `pnpm test` = local runner; `turbo run test` = CI.

**Browser verification = Playwright specs, not a browser MCP.** To check UI
or a flow, write/run an `apps/web/e2e/*.spec.ts` and run it with
`pnpm --filter @crm/web exec playwright test e2e/<file> --reporter=line`
(stub external hosts with `page.route`). Pass/fail text is all that reaches
context; open the trace/screenshot under `test-results/` only on failure.
Do not enable `chrome-devtools` / Playwright MCP / Claude-in-Chrome for this
repo: their tool definitions (~14–19k tokens) and per-step page snapshots
are the costly path. The `browser-testing-with-devtools` skill is the
exception only for live console/network/perf debugging the user asks for.

Docs: `DESIGN.md`, `docs/architecture/`, `docs/adr/`, `docs/domains/`,
`docs/database/`, `docs/development/` (`workflow.md`, `how-tos.md` — recipes
for domain modules, providers, jobs, UI — `cicd.md`, `getting-started.md`).

## Definition of done

`pnpm verify` green; `pnpm verify:full` (adds integration + e2e + build) for
anything touching DB/providers — see `docs/development/workflow.md` → Gates.

## Do NOT

- No `apps/worker` without an ADR (see docs/adr/0010).
- No new infrastructure services or dependencies without justification.
- No Terraform/Kubernetes (yet). No microservices, extra queues or extra
  databases — ask "what concrete problem does this solve now?" first.
- Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`...).

## Tooling (integrations)

- **GitHub**: use the `gh` CLI for all operations (PRs, checks, releases).
- **Coolify**: only via the `coolify` MCP tools — never raw REST/curl to
  the panel (real host in `docs/development/deployment.local.md`). The MCP
  is read + deploy + start/stop/restart; for
  config writes it doesn't expose (envs, fqdn, healthcheck), escalate to the
  user instead of bypassing.
