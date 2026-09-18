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

## Next phases

Phase 8 is the next implementation target: Game execution through Konami.

Then:
1. Game execution
2. Verification / 100% completion
3. User dashboard and live task changes
4. Security, secrets and billing
5. Production worker infrastructure
6. RazeKit integration

See `ROADMAP.md` for the complete phase contract.
