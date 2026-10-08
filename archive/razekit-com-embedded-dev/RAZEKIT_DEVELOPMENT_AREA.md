# RazeKit Development area (RazeKit DEV)

The autonomous app, website and game build area inside RazeKit. Built **in this
repository**, walled off from the contest marketplace.

## Status: switched off

**The Development area is off, and off is the default.** Two switches, both of
which must be on before any of it exists:

| Switch | Where | Default | Effect when off |
|---|---|---|---|
| `DEV_AREA_ENABLED` | RazeKit API | `false` | The router is not mounted and no DEV code is constructed. `/api/development/*` returns the same 404 as an address that was never built. |
| `VITE_DEV_AREA_ENABLED` | RazeKit web build | `false` | No route, no navigation entry, no page chunk, no API surface in the bundle. |

Verified by building with the web switch off: no `Development` or `BuildDetail`
chunk is emitted and the strings `development`, `api/development` and
`Idempotency-Key` appear zero times in `dist/assets/*.js`.

Even with both switches on, **production refuses to run builds** until the
missing pieces below exist. It reports which ones are missing
(`GET /api/development/admin/health`, and the API's startup log) instead of
falling back to something weaker.

## One product, walled domains

```
                         RAZEKIT — one website, one API, one account
                                         │
             ┌───────────────────────────┴───────────────────────────┐
             ▼                                                       ▼
   DEVELOPMENT AREA (RazeKit DEV)                        CONTEST MARKETPLACE
   /development · /api/development                       explore · tracker · winners
   server/src/development                                everything else
             │                                                       │
             └────────────── shared core, nothing else ──────────────┘
          accounts & sessions · config · double-entry ledger · fee engine
          rate limiter · error capture · private object storage
```

A user signs in once and reaches both. Domain logic is not shared: the build
engine knows nothing about contests and the marketplace knows nothing about
builds. `server/test/dev-boundary.test.ts` enforces that on every CI run:

- no marketplace module imports DEV (only `index.ts` mounts it);
- DEV imports only the shared-core modules listed in that test;
- DEV code never names a marketplace entity;
- the same rules hold for the web pages.

## Where things live

| Concern | Location |
|---|---|
| Domain core: states, pre-flight, agents, tool broker, step graph, trust boundary, governor | `server/src/development/engine/` |
| Model providers: Astra (OpenAI), Fable (Anthropic), deterministic pair | `server/src/development/engine/{openai,anthropic,deterministic}.ts` |
| RazeKit Game Runtime and the Endless Runner Kit | `server/src/development/engine/{gameRuntime,templates}.ts` |
| Persistence (own schema `razekit_dev`) | `server/src/development/store/` |
| Workspaces, contained process runner, packager, game-manifest check | `server/src/development/runtime/` |
| Verification (the only way a build completes) | `server/src/development/verification.ts` |
| Orchestrator (one transition per tick) | `server/src/development/orchestrator.ts` |
| Worker process | `server/src/development/worker.ts`, `worker-main.ts` |
| Control plane and HTTP routes | `server/src/development/service.ts`, `routes.ts` |
| Money: funding gate, ledger postings | `server/src/development/funding.ts`, `ledger.ts`, `ledgerUnit.ts` |
| Assembly and production rules | `server/src/development/bootstrap.ts` |
| UI | `src/pages/development/`, `src/lib/development.js` |

DEV state lives in the Postgres schema `razekit_dev`, never in the
marketplace's `records` table, and is unreachable through `/api/entities`. It
can share the platform database or use its own (`DEV_DATABASE_URL`), with its
own connection pool either way.

## How a build runs

```
USER REQUEST
    ↓
PRE-FLIGHT           complexity, predicted agent and tools, estimated budget — creates nothing
    ↓
AUTHORISATION        explicit consent + a hard budget; without consent the build is refused
    ↓
FUNDING              (ledger mode) the whole budget is reserved from purchased budget first
    ↓
QUEUED ─► PLANNING   Astra writes the plan and maps acceptance criteria to machine checks
    ↓
IMPLEMENTING         Fable writes every file, and the test/build/package steps
    ↓
EXECUTING            files written; steps run through the tool broker in dependency order
    ↓
REVIEWING            Astra reviews what was actually built and run — never the intention
    ├── pass   → VERIFYING
    ├── revise → IMPLEMENTING (never back to planning)
    └── block  → DECISION NEEDED
    ↓
VERIFYING            re-runs the tests and checks artifact, budget, isolation, secrets, acceptance
    ├── pass   → COMPLETED (artifact stored privately; ledger settled; unused budget → credit)
    └── fail   → IMPLEMENTING with the failures as repair notes
```

Rules the engine keeps:

- **One transition per tick.** A worker claims a build under a lease, moves it
  one step and saves. Nothing loops inside a tick, so a user who cancels or a
  worker that dies stops it at the next boundary.
- **Only verification completes a build.** It trusts nothing it is told: it
  re-runs the tests, checks the artifact's checksum and contents, and checks
  every acceptance criterion against the built files. A criterion with no
  machine check passes only on the reviewer's explicit word, and is labelled
  "judged by review, not machine-checked".
- **Money before work.** Every model call reserves the most it can cost before
  it is made. A reservation that does not fit stops the build and asks the user
  to raise the limit. The limit is never raised implicitly.
- **Failures are sorted.** Failures outside our control (a provider hiccup, a
  crash) are retried with exponential backoff, up to five times. Our own limits
  (budget, attempts, a refused tool, an unconfigured provider, repeatedly
  unusable model output) stop the build with the reason. They are never retried.
- **Stale workers cannot write.** Every save is compare-and-set on the build's
  revision and presents the lease. A worker that lost its lease has its result
  discarded.
- **Mid-build changes are classified.** A change inside the build's scope ("make
  the hero dark blue") is applied at the next implement. A change that crosses
  a boundary (payments, sign-in, credentials, other people's data) waits for
  approval. A request to build something different ("make it a game") can only
  be declined, and the user is told to start a new build. A change that arrives
  after the code was written is applied before the build may complete.

## Money

Two funding modes, selected by `DEV_FUNDING`:

| Mode | What happens | Where allowed |
|---|---|---|
| `none` | The budget ceiling is enforced per build; no money is held. | development only |
| `ledger` | The build's whole budget is reserved from the user's purchased development budget before it runs, drawing on development credit for any shortfall. When it finishes, what was spent is consumed and the rest returns as development credit. Raising the ceiling mid-build reserves the difference first. | required in production |

Everything posts to RazeKit's **existing double-entry ledger**; there is no
second ledger. The four DEV pots are `DEV_BUDGET_HELD`, `DEV_BUDGET_RESERVED`,
`DEV_BUDGET_CONSUMED` and `DEV_CREDIT`. Their sum is conserved after a
purchase, and credit has no path back to cash.

- **Per-user serialisation.** Every ledger operation for a user runs in one
  transaction under a per-user advisory lock. This was proven necessary against
  real Postgres: without the lock, four builds of 600 were approved against a
  balance of 1500.
- **Purchases.** A purchase is recorded by an administrator against a verified
  payment, using the same manual-verification model the beta uses for contest
  funding (`POST /api/development/admin/budget-purchases`). The 15% platform fee
  comes from the fee engine (`money/fees.ts`). Recording is idempotent on the
  payment reference. No self-serve checkout exists yet; see the blocker table.
- **Credit.** Credit is spent before a build would be refused for want of
  purchased budget, and only as far as needed. Each draw is idempotent on the
  reservation it funds, so raising a build's budget can draw again.
- **Settlement.** Settlement runs once per finished build, under the worker's
  lease, after any orphaned reservations are released. It reads the build's
  reservations from the ledger itself, not only from the build's own record,
  so a process that died between reserving and recording cannot strand money.
  A retried reservation is recognised as a replay before any balance
  arithmetic.
- **Races with workers.** A raised budget is reserved on the ledger before it
  is recorded on the build. Recording it, like stopping a build, is retried
  against the latest version if a worker saved at the same moment. A
  reservation the build does not know about would never be settled.

Per build, the budget ceiling is also a database CHECK constraint
(`spent + reserved ≤ max`), so even a bug in the governor cannot record
overspend. A provider bill above a reservation is recorded as RazeKit's overrun
and never charged to the customer.

## Models

| Role | Provider | Default model | Key |
|---|---|---|---|
| Astra: plan, review | OpenAI Chat Completions, strict JSON schema | `gpt-5.6-sol` (`DEV_ASTRA_MODEL`) | `ASTRA_API_KEY` |
| Fable: implement | Anthropic Messages API via the official SDK: streamed, structured output | `claude-fable-5-1` (`DEV_FABLE_MODEL`) | `FABLE_API_KEY` |

DEV has its own keys (`ASTRA_API_KEY`, `FABLE_API_KEY`), separate from the
marketplace's `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, so DEV spend and
rotation never touch the marketplace's support assistant.

- **Powerful models only.** Each role has an approved list
  (`DEV_ASTRA_ALLOWED_MODELS`, default `gpt-5.6-sol`; `DEV_FABLE_ALLOWED_MODELS`,
  default `claude-fable-5-1, claude-fable-5, claude-opus-5-5, claude-opus-5`).
  A configured model outside its list leaves that provider unavailable: the
  build does not start, rather than running on something else. Nothing
  downgrades a model because of budget, load or failure: a model that is
  unavailable stops the step, and the failure says why.
- **Refusal fallback is off** (`DEV_FABLE_REFUSAL_FALLBACK=false`). A request
  Fable's safety classifier declines stops the step. If an operator turns it
  on, Anthropic re-runs a declined request on its recommended fallback model,
  and the answer is still refused unless the model that served it is on the
  approved list.

- **Prices** (`DEV_*_PRICE_INPUT/OUTPUT`, minor units per million tokens) drive
  both the pre-flight estimate and the governor's reservations. Check them
  against the providers' current price lists before enabling real models.
- **Validation.** Every model answer is validated before it is acted on: paths,
  sizes, the step graph, and every step through the tool broker. Anything that
  fails is refused whole.
- **Deterministic pair.** Without both keys, and outside production, a
  deterministic pair runs instead. Its plan is real, its files are real
  (a landing page, a small app, or an endless-runner game on the RazeKit Game
  Runtime), its tests really run, and completion is still verification-gated.
  It costs nothing and says which refinements it cannot apply. Production never
  uses it.

## Delivery to GitHub

A finished, verified build can be delivered to a GitHub repository by its
owner (`POST /tasks/:id/deliver`, or **Deliver to GitHub** on the build page).
It is done as the **RazeKit DEV GitHub App**, never with a personal token:

1. The App signs a JWT with its private key (RS256, eight minutes) and finds
   its installation on the repository.
2. It exchanges the JWT for an installation token scoped to **that one
   repository**, with only `contents: write` and `pull_requests: write`.
   Tokens are reused until five minutes before expiry; a token GitHub rejects
   is replaced once and the call retried.
3. It writes the build's source (the files Fable wrote and verification
   passed, plus any provided runtime) under `razekit-dev/<buildId>/` on a new
   branch `razekit-dev/<buildId>`, and opens a **draft** pull request against
   the base branch. It never writes to the base branch, never force-pushes
   and never merges.

Delivery is idempotent on the branch name: a retry after a lost answer finds
the branch and pull request it already made. The repository must be on the
operator's list (`DEV_GITHUB_DELIVERY_REPOS`), because a RazeKit account is not
yet linked to a GitHub identity; without that list anyone with a build could
open pull requests in any repository the App is installed on.

Configure with `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (the PEM; literal
`\n` sequences are accepted). The installation is discovered per repository,
so no installation id is needed.

## Runtime and containment

| Runtime | What it is | Production |
|---|---|---|
| `local` | A process on the worker. | refused |
| `sandbox` | A per-build container or microVM. Not attached yet; it reports itself unavailable. | required (blocked) |

The local runtime is **not a sandbox**, and nothing claims it is. What it does
enforce:

- **Node permission model.** Each build process may read and write only its
  own workspace, and may not spawn processes, start workers or load addons.
  Tested: reading another build's workspace, `/etc/passwd`, or spawning `id`
  all fail with `ERR_ACCESS_DENIED`.
- **Clean environment.** The environment is built from nothing, so none of the
  worker's own variables (database URL, provider keys) reach the build.
- **Broker-built commands.** There is no shell, and every argv is built by the
  tool broker: a model names files, never flags or commands.
- **Limits.** Each step has a kill timeout, a memory ceiling, and capped,
  redacted output.
- **Workspace hygiene.** Paths are validated and never "cleaned up". There is
  no hidden-file or `node_modules` write, and files left over from a previous
  attempt are removed.

What the local runtime cannot stop is network access or a native-code escape.
That needs the sandbox runtime.

Games get the **RazeKit Game Runtime** (`vendor/razekit-game-runtime.mjs`): a
fixed-step loop, input mapping, AABB collision and a seeded RNG. It is RazeKit's
file; builds may import it but not modify it, and the `engine` tool verifies its
checksum and the `game.json` manifest.

## Running it locally

One process, with an in-process worker:

```bash
cd server
DEV_AREA_ENABLED=true DEV_WORKER_INPROCESS=true npm run dev
# and, from the repository root, for the web app:
VITE_DEV_AREA_ENABLED=true npm run dev
```

With `DATABASE_URL` set, DEV uses the `razekit_dev` schema in that database;
without it, an in-memory store.

Or two processes, the way production runs it:

```bash
cd server && DEV_AREA_ENABLED=true npm run dev          # API
cd server && DEV_AREA_ENABLED=true npm run dev:worker   # worker (needs Postgres)
```

## Deploying

Nothing in `render.yaml` changes. To run DEV in production, all of the
following must be done:

1. On the API service: `DEV_AREA_ENABLED=true`, `DEV_FUNDING=ledger`,
   `ASTRA_API_KEY`, `FABLE_API_KEY`, and optionally `DEV_DATABASE_URL`.
2. A worker service built from the same code: root `server`, build
   `npm install --include=dev && npx prisma generate && npm run build`, start
   `npm run start:dev-worker`, with the same DEV variables. Workers dial out to
   the database; no address is configured anywhere.
3. A sandboxed runtime (`DEV_RUNTIME=sandbox`). This is not built yet; until it
   is, production readiness reports it as the blocker.
4. On the web build: `VITE_DEV_AREA_ENABLED=true`, then rebuild.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DEV_AREA_ENABLED` | `false` | Master switch (API). Only the exact string `true` enables it. |
| `DEV_STORE` | `postgres` if a database URL is set, else `memory` | `memory` is refused in production. |
| `DEV_DATABASE_URL` | `DATABASE_URL` | DEV's own database, if wanted. |
| `DEV_DB_SCHEMA` | `razekit_dev` | |
| `DEV_RUNTIME` | `local` | `local` or `sandbox`. |
| `DEV_WORKSPACE_ROOT` | OS temp dir + `/razekit-dev-workspaces` | |
| `DEV_BUILD_MEMORY_MB` | `256` | Per build process. |
| `DEV_KEEP_WORKSPACES` | `false` | Keep settled builds' workspaces on the worker's disk. Off by default: a completed build's artifact lives in private object storage, and its workspace is removed once it is settled. |
| `DEV_MODEL_MODE` | `auto` | `auto`, `real` (never falls back) or `deterministic` (refused in production). |
| `ASTRA_API_KEY`, `DEV_ASTRA_MODEL`, `DEV_ASTRA_BASE_URL`, `DEV_ASTRA_PRICE_INPUT/OUTPUT`, `DEV_ASTRA_MAX_PLAN_TOKENS`, `DEV_ASTRA_MAX_REVIEW_TOKENS` | see `config.ts` | |
| `FABLE_API_KEY`, `DEV_FABLE_MODEL`, `DEV_FABLE_PRICE_INPUT/OUTPUT`, `DEV_FABLE_MAX_OUTPUT_TOKENS`, `DEV_FABLE_EFFORT` | see `config.ts` | |
| `DEV_ASTRA_ALLOWED_MODELS`, `DEV_FABLE_ALLOWED_MODELS` | see Models | the only models each role may run |
| `DEV_FABLE_REFUSAL_FALLBACK` | `false` | re-run a declined request on Anthropic's fallback model |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | unset | the RazeKit DEV GitHub App; delivery is off without them |
| `DEV_GITHUB_DELIVERY_REPOS` | empty | `owner/name` list that builds may be delivered to |
| `DEV_GITHUB_DELIVERY_DIR` | `razekit-dev` | directory the delivered files go under |
| `DEV_FUNDING` | `ledger` in production, `none` otherwise | |
| `DEV_PLATFORM_FEE_BPS` | `1500` | 15%. |
| `DEV_MAX_TASK_BUDGET_MINOR` | `50000` | $500 per build. |
| `DEV_MAX_IMPLEMENT_ATTEMPTS` | `4` | |
| `DEV_LEASE_MS` | `300000` | |
| `DEV_WORKER_INPROCESS` | `false` | Ignored in production. |
| `DEV_WORKER_CAPACITY`, `DEV_WORKER_CAPABILITIES` | `2`, `web,game` | Declare capabilities honestly. |
| `DEV_PUBLIC_VISIBILITY` | `hidden` | Starting point for the public entry; an admin's choice (stored) overrides it |
| `DEV_RUNTIME=fargate`, `DEV_AWS_REGION`, `DEV_AWS_CLUSTER`, `DEV_AWS_TASK_DEFINITION`, `DEV_AWS_CONTAINER`, `DEV_AWS_SUBNETS`, `DEV_AWS_SECURITY_GROUPS`, `DEV_AWS_BUCKET`, `DEV_AWS_PREFIX` | unset | The sandboxed runtime; `terraform output worker_environment` gives the values. AWS credentials come from the standard provider chain |
| `DEV_GODOT_BIN`, `DEV_UNITY_EDITOR`, `DEV_UNREAL_ROOT` | unset | Where a worker's engines are, for detection only |
| `ZERNIO_API_KEY`, `ZERNIO_BASE_URL` | unset, `https://zernio.com/api` | Kit publishing |

Provider keys never reach the browser, a build process, a log line or stored
state. The end-to-end check plants a canary key and searches every DEV table
and the worker's output for it.

## API

All routes need a signed-in account and only ever see that account's builds;
another account's build reads as "not found".

| Route | |
|---|---|
| `GET /status`, `GET /budget` | availability; purchased budget and credit (ledger mode) |
| `POST /tasks/analyze` | pre-flight; creates nothing |
| `GET/POST /tasks`, `GET/PATCH /tasks/:id` | list, create (`Idempotency-Key` supported), read, rename |
| `GET /tasks/:id/dashboard`, `/events`, `/acceptance` | the Control Center projection |
| `GET /tasks/:id/artifact` | a 10-minute signed URL for the finished artifact |
| `POST /tasks/:id/commands` | a mid-build change, classified |
| `POST /tasks/:id/changes/:changeId/approve` / `deny` | answer a decision; raising the limit is explicit (`maxBudget`) |
| `POST /tasks/:id/cancel` | stop; the worker settles it |
| `POST /tasks/:id/deliver` | deliver a finished, verified build to GitHub as a draft pull request (`{ repository: "owner/name" }`) |
| `GET /visibility` | anyone, signed in or not: `{ visible }` for the public entry, nothing else |
| `GET /engines` | game engines and whether each can build here |
| `GET/POST /kit/posts`, `PATCH /kit/posts/:id`, `POST /kit/posts/:id/{submit,refresh,abandon,cancel}`, `GET /kit/accounts` | Kit |
| `GET /admin/health`, `POST /admin/execution`, `POST /admin/budget-purchases` | admins only: readiness, queue and workers; the emergency pause; verified purchases |
| `POST /admin/visibility` | admins only: show or hide the public entry (recorded with who, when, why) |
| `GET /admin/battle`, `POST /admin/battle/settings`, `POST /admin/battle/benchmark`, `POST /admin/battle/:id/decision` | admins only: Battle Mode |
| `GET/POST /admin/incidents`, `POST /admin/incidents/action` | admins only: the Dev Department |
| `POST /admin/kit/profiles` | admins only: link a user to a Zernio profile |

Operators get the same controls at **`/development/ops`**, an admin-only page in
the Development area, kept out of the marketplace admin console. It shows:
- readiness and why the area is not ready, if it isn't
- queue and worker state, providers and runtime
- the pause switch, which records a reason
- a form to record a verified budget purchase

## Verifying

```bash
cd server && npm test                          # includes every DEV suite
DEV_TEST_DATABASE_URL=postgresql://…local… npm test   # + the Postgres store and ledger tests
DEV_E2E_DATABASE_URL=postgresql://…local… npm run verify:development
```

`verify:development` runs this repository's API and a separate worker process
against a throwaway schema, and drives real website, game and cancelled builds
over HTTP (40 checks). `dev-workers-pg.test.ts` races two workers over one
queue and checks no build phase ever runs twice. CI runs all of the above
against a Postgres 16 service.

## Status

| Capability | State |
|---|---|
| Off-switches, marketplace boundary | **Verified** |
| Store (Postgres and memory), leases, CAS, budget constraint | **Verified** on Postgres 16 |
| State machine, orchestrator, worker, retries, pause | **Verified** |
| Budget governor, ledger funding, settlement, credit, verified purchases | **Verified** on the real ledger |
| Tool broker, trust boundary, local containment | **Verified** on Node 20 and 22 |
| Verification gate, packaging, game runtime and manifest check | **Verified** |
| Control plane, routes, UI | **Verified**, including in a browser |
| Deterministic Astra/Fable | **Verified** |
| Real Astra (OpenAI) and Fable (Anthropic) adapters | **Configured but not verified**: tested against faithful fakes. In the build environment `api.openai.com` is blocked by network policy and the keys are not installed as environment secrets |
| Sandboxed runtime: one Fargate task per invocation (`DEV_RUNTIME=fargate`) | **Implemented and tested** end to end with the real runner behind a fake ECS/S3; Terraform passes `terraform validate`. **Not applied**: needs an AWS account session and a credential for the worker |
| Konami engines: RazeKit runtime (real), Godot/Unity/Unreal (detected, not driven) | **Verified** for the RazeKit runtime; other engines report unavailable until a worker has them |
| Headless game playtest in verification | **Verified** (crash, NaN, replay, frozen, hang, step budget; contained) |
| Public entry switch (admin) | **Verified** in a browser for visitor, user and admin |
| Email notifications (decision, done, failed, delivered) | **Implemented and tested**; real Resend delivery not exercised here |
| Battle Mode: telemetry, baselines, detection, bounded battles, benchmark | **Verified** for telemetry, detection, limits and the benchmark; Astra challenges need the real model. **Not built**: Fable implementing changes to RazeKit itself (needs a platform build workspace) |
| Dev Department: intake, fingerprinting, regressions, fixes as PRs | **Verified**; Astra root cause needs the real model |
| Kit through Zernio | **Implemented and tested** against Zernio's REST contract (from its official SDK); not run against the real API (zernio.com is not reachable here) |
| DEV visual layer: theme, spider, particles, assistant | **Verified** in a browser, including reduced motion and mobile width |
| Self-serve budget checkout | **Blocked**: no payment provider decision for DEV; admin-verified purchases work |
| Repository delivery (branch, commit, draft PR) as the GitHub App | **Implemented and tested** against an in-memory GitHub that checks the App's JWT signature and token scope; **not yet run against real GitHub** (this environment only reaches repository-scoped GitHub endpoints, and the App's token exchange is not one) |
| Browser checks, web deployment of builds | **Not attached**: reported unavailable by the tool broker |

## Konami: engines and the playtest

Engines are adapters that are **probed, never assumed** (`konami/engines.ts`):

- The RazeKit Game Runtime is the engine builds run on.
- Godot, Unity and Unreal are detected on the worker and reported with the reason they cannot build here yet.
- A game build that asks for an unavailable engine is refused before any money moves.

Every game is **played** in verification (`konami/playtest.ts`):

- `game.json` declares `simulation: { module, factory }`.
- The built output's own module runs under the build containment for 3600 steps, pressing the game's declared controls on a seeded schedule.
- A build fails if it throws, produces NaN, cannot replay the same seed identically, freezes, hangs, or exceeds the step budget.

## The sandboxed runtime on AWS

`DEV_RUNTIME=fargate` runs each build invocation (test and build steps, the verification re-run, the playtest) in its own Fargate task. See `runtime/aws/` and `infra/aws/dev-runtime/README.md`:

- The worker packs the workspace into S3 and starts one task that receives only two pre-signed URLs.
- It stops the task at the deadline.
- It takes the workspace back through an archive check that refuses links, special files and escaping paths.
- RunTask is idempotent on the run id.
- The task role has no permissions.
- The VPC has no internet route; its only way out is VPC endpoints.

## Public entry and notifications

- **Public entry.** An administrator shows or hides the RazeKit DEV entry, on `/development/ops` or with `POST /admin/visibility`:
  - Visitors see the entry on the landing page, signed-in users in the navigation, and administrators always.
  - Hiding removes only the entry; builds, data and workers are unaffected.
  - Anyone may read `GET /visibility`, which returns only `{ visible }`.
- **Email.** The owner is emailed once when a build needs a decision, finishes, fails, or is delivered:
  - It goes through the platform's existing email integration.
  - The address comes from the signed-in session.
  - Each notification is claimed atomically first, so retries send one email.
  - A failed send never affects the build.

## Battle Mode and the Dev Department

Both read what settled builds leave behind (`platform/`). Neither can spend a customer's budget or change code by itself.

**Battle Mode** is admin-controlled: off, observe or analyze.
- It keeps per-type baselines and detects problems only when enough samples back them.
- Astra's challenge comes from the real model only. It is a decision record: cause, smallest safe change, proof, undo.
- The challenge runs inside a separate monthly and per-battle platform budget, checked before any call.
- A battle stops at `FABLE_IMPLEMENT`. Changing RazeKit's own code needs a platform build workspace that DEV does not have.
- Promotion and rollback are recorded against the merged pull request.
- A benchmark builds a website, an app and a game for real, and compares each run with the last.

**The Dev Department** turns platform-caused build failures, unexpected errors and operator reports into incidents:
- Each incident is fingerprinted and counted, and redacted before it is stored.
- A resolved incident that recurs reopens as a regression.
- Astra's root cause comes from the real model, on the platform budget.
- A fix is a pull request, recorded here.

## Kit

Kit publishes one post with per-platform versions through Zernio. The contract comes from Zernio's official SDK: `GET /v1/accounts`, `POST /v1/posts` with `x-request-id`, and `GET /v1/posts/{id}`.

- Each variant is reviewed against its platform's limit.
- A post counts as published only when Zernio says so, and Kit shows no metric it did not get from Zernio.
- A user may post only to the accounts of the Zernio profile an admin linked to them. This is checked again at submit.
- A lost answer leaves the post "outcome unknown":
  - Inside Zernio's idempotency window, a status check re-asks with the same request id and never creates a second post.
  - After the window, a person decides.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/development` is Not Found | The web app was built without `VITE_DEV_AREA_ENABLED=true`. That switch is build-time, so it needs a rebuild. |
| `/api/development/*` returns 404 | `DEV_AREA_ENABLED` is not exactly `true`. |
| "Development is not switched on for this deployment" | Both switches are on, but the engine is not ready. `GET /api/development/admin/health` (as an admin) lists why. |
| Builds stay "Starting" | No worker is running, or execution is paused (`POST /admin/execution {"paused": false}`). |
| A build stops at "Budget limit reached" | Working as intended: raise the limit when approving, or decline to stop and settle. |
| A build is BLOCKED with "unusable output" | The model failed validation three times in a row; the reasons are in the build's audit events. |
| `dev:worker` exits immediately | It prints why: the area is off, or the engine is not ready. The worker also needs the Postgres store. |
