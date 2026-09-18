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

## Next phases

Phase 11 is complete.

Then:
1. Security, secrets and billing
2. Production worker infrastructure
3. RazeKit integration

See `ROADMAP.md` for the complete phase contract.

See `ROADMAP.md` for the complete phase contract.
