# RazeKit DEV

Standalone foundation for autonomous app/web and game development agents.

## Core model

- App / Website → **Niomi**
- Game → **Konami**
- One task → one isolated active agent instance
- Fable + Astra are coordinated model sessions inside that instance.
- Workspace, worker, state, tools, credentials, logs and budget are task-scoped.
- Completion is gated by objective acceptance criteria.

## Phase 1 — Task Creation

- App / Website / Game tasks
- Preflight analysis
- Predicted tools/services
- Estimated budget + hard maximum budget
- Explicit autonomous-execution authorization
- Acceptance criteria
- Persistent task state
- Task progress

## Phase 2 — Agent Manager

- Niomi/Konami routing
- One agent instance per task
- Dedicated worker + workspace
- Task-scoped tool manifest
- Model configuration
- Budget attachment
- Start / heartbeat / cancel / fail / complete
- Acceptance-gated completion
- Task chat messages

## Phase 3 — Worker Runtime & Execution Foundation

- Worker runtime states and leases
- Lease ownership and renewal
- Expired-lease recovery
- Resumable worker checkpoints
- Execution plan / step contract
- Step retry and timeout handling
- Runtime cancellation on timeout
- Controlled local process adapter for development
- Workspace-bound execution directory
- Executable allowlist
- No shell invocation by default
- Internal worker lease/checkpoint APIs
- Runtime adapter boundary kept separate from model providers

### Current execution boundary

Phase 3 deliberately does **not** pretend to be a production sandbox. The local process adapter is a development/testing adapter. Production workers will later use containers or microVMs with stronger network, filesystem, process and credential isolation.

## Tests

Run:

```bash
npm test
```

GitHub Actions runs the test suite on pushes and pull requests.

## Phase 4 — Niomi / Konami Model Orchestrator

- Per-agent Fable and Astra model sessions
- Planner → implementer → reviewer orchestration
- Private task blackboard per agent
- Model request/response history per session
- Context compaction and persistent snapshots
- Retryable vs terminal model failures
- Per-model usage and cost accounting
- Internal orchestration provision / step / state APIs
- Deterministic model adapters for CI tests

The model layer is provider-neutral. Real production model credentials/adapters are deliberately not embedded in this phase.

## Phase 5 — Tool, MCP & Permission Broker

- Central tool registry
- Task-scoped manifest enforcement
- Exact permission scopes and one-time preauthorization
- New permission request + approve/deny flow
- Credential-reference abstraction with expiry and explicit credential requests
- Tool-call audit records
- Missing-adapter audit records
- Per-agent permission and credential isolation
- Internal authorization, credential and tool invocation APIs

Real provider-specific OAuth adapters and production secret-vault integration remain external infrastructure work; this phase keeps secrets out of the application database.

## Phase 6 — Persistence, Recovery & Reliability

- Versioned durable state schema with migrations
- Durable per-agent checkpoints with versioning
- Worker lease-expiry detection and automatic agent recreation
- One active workspace/agent instance maintained per task during recovery
- Failed worker checkpoint carried into the recreated worker
- Fable/Astra model sessions, messages, usage, blackboard and orchestration state carried forward
- Persistent job queue with leases and deterministic claim filters
- Retry/backoff, blocked and dead-letter job states
- Expired job lease recovery
- Idempotency claims with stale-claim recovery
- Recovery event records
- Internal checkpoint, queue and recovery APIs

Production deployment still requires a real durable database, distributed queue/lock service and external workflow runner; this phase establishes the application-level contracts and recovery semantics.

## Phase 7 — App / Website Execution

- Structured Niomi App/Web execution plans
- Repository initialization with Git
- Workspace-scoped file creation/editing
- Allowlisted Node/npm/Git command execution
- Database/auth/service adapter boundary
- Browser smoke-test adapter boundary
- Deployment adapter boundary
- Automated test and build execution
- Durable execution checkpoints and execution-run persistence
- npm artifact packaging
- Execution evidence/results written to the isolated agent blackboard
- Workspace escape protection

The provider-neutral service, browser, database/auth and deployment adapters remain intentionally injectable. Provider-specific production implementations are part of the infrastructure/integration work in later phases.

## Phase 8 — Game Execution

- Engine-neutral Konami execution plans
- Configurable Unity, Unreal and Godot adapters
- Engine executable/action/build-command configuration
- Project initialization contracts
- Workspace-scoped asset creation and copy pipeline
- Automated playtest adapter with explicit checks
- Engine build adapter boundary
- Durable game execution checkpoints and run records
- Artifact manifests with file inventory
- Game execution evidence/results written to the isolated agent blackboard
- Workspace escape protection

The actual Unity/Unreal/Godot SDKs and production worker images remain infrastructure concerns. Konami uses explicit adapter bindings so the same execution contract can run against different engine installations without changing the orchestrator.

## Phase 9 — Verification & 100% Completion

- Objective verification runs per task/agent
- Acceptance criteria are updated from verifier evidence
- Execution plans must finish with every step passed
- Test/build/playtest/smoke evidence is checked
- Deployment evidence is checked when deployment steps exist
- Artifact evidence is checked against the isolated workspace
- Hard budget and workspace isolation are verified
- Failures are categorized by execution domain
- Verification history is persisted
- Agent completion now requires a passing verification run plus passed acceptance criteria
- Manual mutation of acceptance status alone cannot produce 100% completion

## Phase 10 — User Control Dashboard

- Chat-first browser control panel at `/`
- High-value status projection without low-level tool/test noise
- WORKING / DECISION NEEDED / IMPORTANT UPDATE / BLOCKED / COMPLETED states
- Live user change commands
- Impact classification for in-scope versus scope-expanding requests
- Hard-budget impact checks before approval
- Persistent change requests and user-facing update history
- Task progress derived from execution and acceptance evidence
- Deliverable aggregation from execution artifacts
- Approve/decline flow for scope changes

## Standalone Frontend

The browser frontend at `/` is complete and standalone. It provides:
- Task creation with preflight analysis and autonomous authorization
- Task selection with live 5-second status refresh
- WORKING / DECISION NEEDED / IMPORTANT UPDATE / BLOCKED / COMPLETED states
- Chat-based task changes
- Scope-change approvals and hard-budget escalation
- Task editing and cancellation
- Progress, acceptance, budget and verification summaries
- Deliverable and important-update panels
- Responsive mobile layout
- Toast-based error/success feedback
- No RazeKit integration or external project coupling

## Phase 11 — Security, Secrets & Billing

- Tenant/user isolation boundary for public task APIs
- Provider-neutral secret vault adapter boundary
- Scoped temporary credential leases with expiry and revocation
- Redacted security audit log
- Provider billing adapter registry
- Atomic spend reservations, hard budget enforcement and idempotent billing
- Durable billing ledger
- Active-task, command, tool-call and hourly-spend abuse controls
- Admin token controls for tenant suspension/resume, limits, cancellations, credential revocation and audit inspection
- Public task PATCH restricted to safe mutable fields
- Optional HMAC-signed principal mode for production tenant/user authentication boundaries

## Phase 12 — Production Infrastructure

- Provider-neutral container and microVM runtime boundaries with hardened defaults
- CPU and GPU worker pools over the existing durable job queue
- Atomic production job assignment and resource-class routing
- Worker heartbeat, stale-worker rejection and drain/offline controls
- GPU worker specifications for game workloads
- Durable Postgres state adapter boundary
- Persistent tenant-scoped object/artifact storage
- Network policy with HTTP(S) allowlists, port controls and private-network rejection
- Infrastructure metrics, events and threshold alerts
- Runtime coordinator recovery for production worker assignments
- Infrastructure status, worker-pool, job, artifact and alert APIs

Phase 12 is complete. GitHub Actions run 205 passed all 79 tests on Node 24.
 
## Phase 13 — RazeKit integration

The engine is now the Development area of the RazeKit product. It remains a
standalone service with its own tests, its own dashboard and no dependency on
RazeKit; what changed is that RazeKit can drive it.

- Signed-principal identity: RazeKit vouches for a signed-in account, so the
  engine needs no user table of its own and nobody signs in twice. One RazeKit
  account maps to one engine tenant.
- Real model adapters (below) alongside the deterministic pair.
- A real autonomous loop (below) that drives tasks without being told to.
- A self-registering worker agent for cloud machines.

Integration guide, trust boundary and troubleshooting live in the RazeKit
repository: `RAZEKIT_DEVELOPMENT_AREA.md`.

### Real model providers

The model layer stays provider-neutral; these are two adapters behind the same
interface, configured entirely from the environment.

| Role | Provider | Model | API |
|---|---|---|---|
| **Fable** — implementation, coding, execution-plan generation | Anthropic | `claude-fable-5-1` | Messages |
| **Astra** — architecture, planning, review, revision and blocking decisions | OpenAI | `gpt-6-astra` | Responses |

`RAZEKIT_MODEL_MODE` selects `test` (deterministic pair), `real` (live
providers, refuses to start without both keys) or `auto` (real when both keys
are present). The deterministic adapters are not scaffolding — they exercise the
whole loop with real files, real tests, a real build and a real artifact, with
no network and no bill.

### The autonomous loop

`src/autonomous-loop.js` is the state machine that actually drives a task:

```
PLAN (Astra) → IMPLEMENT (Fable) → EXECUTE (tools) → REVIEW (Astra)
                        pass   → VERIFY → COMPLETED
                        revise → back to IMPLEMENT
                        block  → DECISION NEEDED
```

It performs at most one transition per call, over persisted state, so a worker
can die between any two transitions and the next tick resumes where it stopped.
Execution runs *before* review, so a review always judges a result rather than
an intention; and a passing review does not complete a task — verification runs
separately and overrules the reviewer.

### Persistence

Two backings, selected explicitly by `RAZEKIT_STORE` — never inferred.

| | `json` | `postgres` |
|---|---|---|
| Where | one file, `data/db.json` | Neon, schema `razekit_dev` |
| Atomicity | one in-process promise chain | `pg_advisory_xact_lock` inside a real transaction |
| Safe with >1 container | **no** | yes |
| Use for | local development, CI | production |

The JSON store is not merely slower in production — it is wrong, and quietly.
Two containers each get their own file and neither can tell; the "atomic" job
claim is only atomic inside whichever process runs it. `assertProductionStore()`
runs at startup under `NODE_ENV=production` because that is the last moment the
mistake is still visible.

All 24 dependent modules are unchanged: the store surface is three functions
(`loadDb`, `transact`, `id`) and both backings implement it. A transaction reads
the whole document in one query, as the file store read the whole file, and
writes back only the rows that changed.

Job claiming is the exception, and deliberately does not take the global lock:
every worker polls the same queue, so serialising them would make N workers take
turns for work that is disjoint by definition. `FOR UPDATE SKIP LOCKED` gives
each worker a different row, and the row lock — not a check-then-write in
application code — is what makes it exclusive.

Timestamps in a claim come from the caller, never from the database. Every job
timestamp is written by the application, so comparing one against the database's
`now()` puts two clocks in one comparison; the gap between a developer laptop
and Neon measured 154 seconds, enough to hide a freshly scheduled retry and to
expire a lease that has not expired.

**Run workers in the same region as the database.** A round trip from outside
the region measured ~250 ms, and a build makes hundreds of transactions — the
same build takes ~200 s from a laptop and is latency-bound, not CPU-bound.

```bash
RAZEKIT_STORE=postgres RAZEKIT_DATABASE_URL=... npm start
npm test            # JSON path; Postgres tests skip cleanly without a database
RAZEKIT_DATABASE_URL=... node --test test/postgres-store.test.js test/postgres-engine.test.js
```

### Worker agent

`node src/worker-agent.js` runs on a worker machine and offers it to the control
plane. The worker dials out and reports its own capacity and capabilities; no
address is configured and none is recorded, so the pool is provider-agnostic and
a worker that stops heartbeating stops receiving work on its own.

See `.env.example` for every setting, and `ROADMAP.md` for the phase contract.
