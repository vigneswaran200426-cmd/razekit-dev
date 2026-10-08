# RazeKit DEV extraction — inventory and decisions

Written before any code moved. It records what existed where, what each piece
became, and the recovery points that make every step reversible.

## Recovery points

| Repository | Ref | Commit | What it holds |
|---|---|---|---|
| `razekit.com` | `backup/pre-dev-extraction-main` | `e95345d` | Marketplace `main` before the DEV removal |
| `razekit.com` | `backup/pr2-embedded-dev` | `d1ec367` | PR #2 head: the DEV product built inside the marketplace (never merged) |
| `razekit-dev` | `backup/pre-migration-main` | `2613f54` | This repository before the migration |

Nothing below deletes history. PR #2 is closed unmerged once its code lives
here; its branch is kept.

## Three DEV implementations existed

1. **This repository (`razekit-dev`)** — the standalone engine: durable JEV
   execution graph, Niomi (app/web) and Konami (game) agents, Fable + Astra
   model sessions, permission broker, credential vault, instruction versions,
   execution levels, model reconciliation, multiprocess workers, Postgres store
   verified against Neon, and the Control Center. Plain Node, no dependencies
   beyond the optional `pg`. **This is the canonical engine.**
2. **`razekit.com` PR #2** — a second engine written inside the marketplace
   server (TypeScript, ~16.5k lines), never merged. Its source is preserved
   verbatim in [`archive/razekit-com-embedded-dev/`](../../archive/razekit-com-embedded-dev/).
3. **`razekit.com` `main`** — not an engine: a proxy (`server/src/development/client.ts`)
   that signed a principal with `RAZEKIT_PRINCIPAL_SECRET` and forwarded to this
   engine, a DEV budget in the marketplace's own ledger
   (`server/src/development/ledger.ts`, `DEV_*` accounts in `ledger/accounts.ts`),
   and two React pages behind `VITE_DEV_AREA_ENABLED`. This is the runtime
   bridge between the products, and it is removed from `main`.

## Disposition of PR #2

Where both engines implement the same thing, this repository's version stays:
it is older, more complete, and verified against real infrastructure.
Where only PR #2 has it, it is ported here, onto this engine's contracts.
Where a piece existed only because DEV lived inside the marketplace, it is
dropped and a DEV-owned equivalent takes its place.

| PR #2 module | Becomes | Why |
|---|---|---|
| `engine/{states,task,dag,agents,trust,preflight,tools,governor,schemas,types,errors,paths}` | superseded by `domain.js`, `task-lifecycle.js`, `jev*.js`, `permission-broker.js`, `budget-manager.js` | Same concepts; this engine's durable graph is the stronger design |
| `engine/{openai,anthropic,providers,pricing,prompts,deterministic}` | superseded by `adapters/astra-openai-adapter.js`, `adapters/fable-anthropic-adapter.js`, `model-providers.js`, `testing-model-adapters.js` | Same providers and roles |
| `orchestrator.ts`, `service.ts`, `worker*.ts`, `projection.ts`, `verification.ts`, `classify.ts` | superseded by `autonomous-loop.js`, `jev-worker.js`, `task-control.js`, `verification.js` | Same lifecycle |
| `store/*` (`razekit_dev` schema) | superseded by `adapters/postgres-store.js` | One store |
| `engine/templates.ts`, `engine/gameRuntime.ts` | superseded by `app-web-executor.js` / `game-executor.js` plans | Same deterministic build output |
| `konami/engines.ts`, `konami/playtest.ts` | compared against `game-engine-adapters.js` / `game-playtest-adapters.js`; gaps ported | Headless playtest checks |
| `runtime/aws/{fargate,clients,runner.mjs}` + `infra/aws/dev-runtime` | **ported**: Fargate process runtime and S3 object store behind this engine's `processRuntime` and `ObjectStorageAdapter` contracts; Terraform moved to [`infra/aws/dev-runtime`](../../infra/aws/dev-runtime/) | Only PR #2 had a real isolated runtime, and it is already applied |
| `delivery/github.ts` | **ported** | GitHub App delivery as a draft PR |
| `notify.ts` | **ported** with a DEV-owned Resend client | Marketplace email integration is not DEV's |
| `artifacts.ts` | **ported** onto the S3 object store in DEV's AWS account | Marketplace R2 bucket is not DEV's |
| `kit/*` | **ported** | Zernio publishing |
| `platform/{battle,benchmark,incidents,telemetry}` | **ported** | Battle Mode and the Dev Department |
| `funding.ts`, `ledger.ts`, `ledgerUnit.ts` | **dropped**; DEV budget is `billing.js` / `budget-manager.js` in DEV's own database | Posted to the marketplace's books |
| `bootstrap.ts`, `routes.ts` (Express, marketplace JWT) | **dropped**; routes are `server.js`, identity is DEV's own accounts | Lived inside the marketplace server |
| public-visibility switch | **dropped** | Controlled the marketplace nav entry |
| `dev-boundary.test.ts` | **dropped**; the repository boundary replaces it | Guarded an import boundary that no longer exists |
| `src/pages/development/*` (React) | design ported into the Control Center (ambient spider, particles, assistant, operations, Kit, platform panels) | The Control Center is DEV's UI |

## DEV-owned replacements for marketplace dependencies

| Was (marketplace) | Becomes (DEV) |
|---|---|
| Marketplace JWT + signed principal | DEV accounts: scrypt password hashes, server-side sessions, owner bootstrap |
| Marketplace Postgres (`DATABASE_URL`, ledger) | Neon project `razekit-dev` only (`DATABASE_URL` of this service) |
| Marketplace R2 private bucket | S3 bucket in DEV's AWS account |
| Marketplace `EMAIL_*` / `RESEND_API_KEY` | DEV's own `RESEND_API_KEY` and sender |
| Marketplace Render services | `razekit-dev-*` services |

## Infrastructure found

| Provider | Found | Plan |
|---|---|---|
| Neon | Project `razekit-dev` (`frosty-pond-12955506`, us-east-2) already exists, separate from the marketplace's `razekit` and `admin-razekit` projects | Use it; no duplicate |
| Render | No DEV services; the marketplace runs `razekit-api`, `razekit-web` | Create `razekit-dev-*` services from this repository |
| AWS | DEV build runtime applied 2026-09-26 (VPC, endpoints, ECS cluster `razekit-dev`, ECR `razekit-dev-runner`, run bucket, roles, worker policy); state in `razekit-dev-tfstate-*` | Keep; add DEV artifact storage and the worker identity |
| Cloudflare | No DEV zone | Needs the new DEV domain (owner purchase) |
