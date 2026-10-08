# RazeKit DEV in the main repository — audit

Written 2026-09-24, before any DEV implementation in this repository. It
supersedes the integration model in `dev-integration-audit.md` §4: the owner
has decided that RazeKit DEV is developed **inside this repository**, and the
separate `razekit-dev` engine is out of scope. That closes blocker B8.

## Baseline

| Check | Result |
|---|---|
| Code | `main` @ `5e5740c`, no divergence from `origin/main` |
| Server typecheck | clean |
| Server tests | 631 / 631 pass |
| Web tests | 61 pass, 1 skipped |
| Lint, web build, server build | pass |

## What already existed

| Piece | Where | State |
|---|---|---|
| Two off-switches (API + build) | `server/src/config.ts`, `server/src/index.ts`, `vite.config.js`, `src/lib/flags.js` | done, tested, default off |
| Proxy to an external engine | `server/src/development/client.ts`, `routes.ts` | done, but proxied to `razekit-dev`; nothing in this repository executed a build |
| Budget / credit ledger | `server/src/development/ledger.ts`, DEV classes in `server/src/ledger/accounts.ts` | done, tested |
| UI | `src/pages/development/*`, `src/lib/development.js`, `src/lib/api.js` | done; defines the API contract |
| E2E | `server/scripts/verify-development-e2e.ts` | spawned `../razekit-dev`; not runnable in this repository's scope |

## Marketplace boundary

Everything outside the DEV footprint is the marketplace and is not modified:
contests, submissions, scoring, tracker, winners, reviews, polls, social,
traffic, visual, compliance, payments / UroPay, funding, payouts, withdrawals,
finance, support, admin, auth, entities / RLS, and the scheduler's jobs.

DEV may use only this shared core: `config`, `auth/middleware`,
`entities/rls` (types), `entities/service` (as the ledger's service client),
`ledger/accounts`, `ledger/post`, `money/fees`, `middleware/rateLimit`,
`errors/capture`. `server/test/dev-boundary.test.ts` enforces this in both
directions, on the server and in the web app.

## Design decisions

- **Location.** All DEV server code is in `server/src/development/`; all DEV UI
  is in `src/pages/development/`.
- **Persistence.** DEV owns a Postgres schema, `razekit_dev`, with typed tables,
  optionally on its own database (`DEV_DATABASE_URL`). It never uses the
  marketplace `records` table and is unreachable through `/api/entities`.
- **Control plane vs execution.** The API process accepts, governs and
  projects. Builds run in a separate worker process built from the same code,
  so a runaway build cannot take the marketplace API down with it.
- **Money.** The existing double-entry ledger is the only book. No second
  ledger and no second payment system.
- **Contract.** The existing `/api/development/*` contract is kept, so the UI
  that already exists keeps working.

## Production blockers

| # | Blocker | Blocks |
|---|---|---|
| B1 | No sandboxed runtime (AWS not connected) | Production execution. A local process is not isolation, so production refuses the local runtime. |
| B2 / B3 | No `ASTRA_API_KEY` / `FABLE_API_KEY` in the runtime | Real planning and implementation can be written but not verified |
| B4 | No payment provider decided for DEV budget | Self-serve purchase. Admin-verified purchases use the existing ledger. |
| B5 | No GitHub App | Repository clone / branch / PR delivery |

## Outcome

Built in the order the audit set out, each step with its own tests. The current
architecture, configuration and status matrix are in
[`RAZEKIT_DEVELOPMENT_AREA.md`](../RAZEKIT_DEVELOPMENT_AREA.md).

| Step | Result |
|---|---|
| Boundary guard | `server/test/dev-boundary.test.ts`, server and web, both directions |
| Engine core | state machine, trust boundary, paths, tool broker, step DAG, routing, pre-flight |
| Store | Postgres (`razekit_dev`) and memory, one contract test, run on Postgres 16 |
| Money | governor; ledger funding with a per-user advisory lock, proven necessary on real Postgres |
| Providers | Astra (OpenAI) and Fable (Anthropic SDK), validated output; deterministic pair |
| Runtime and verification | contained local runtime (Node 20 and 22), packager, game runtime, evidence-based verification |
| Control plane | orchestrator, separate worker process, service, routes on the existing contract, operator controls |
| End to end | `npm run verify:development`: API plus a separate worker process on Postgres, 40 checks |
| UI | stopped state, build decisions, artifact download, available budget; checked in a browser |

Marketplace regression check: every marketplace server test and every web
test that existed before this work still passes, lint is clean, both builds
succeed, and with `VITE_DEV_AREA_ENABLED` unset the web bundle contains no DEV
code. The one suite that changed is `server/test/development.test.ts`: it
tested the proxy to the external engine, which was removed, and now tests the
in-repo Development API end to end. Its switch-default tests were kept.

The blockers above are unchanged: B1 (sandbox), B2/B3 (provider keys),
B4 (payment provider for self-serve budget) and B5 (GitHub App).
