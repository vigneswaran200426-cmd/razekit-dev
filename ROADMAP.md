# RazeKit DEV — Master Build Plan

This file is the implementation order for the autonomous development platform discussed in the project design sessions.

## Core product model

- One user task creates exactly one isolated active agent instance.
- App / Website tasks use **Niomi**.
- Game tasks use **Konami**.
- Niomi and Konami are agent identities/orchestrators, not shared workers.
- Fable + Astra are separate model sessions coordinated by the agent orchestrator; they are not literally merged model weights.
- Every active task owns its workspace, worker, state, tool permissions, credentials, budget ceiling and logs.
- Normal task changes are handled while running; genuinely new external authorization can pause the task.
- Completion requires objective acceptance criteria to pass before the worker is stopped.

## Phase 0 — Architecture contract
**Status: complete**

Freeze terminology, lifecycle, isolation rules, authorization model, budget ceiling semantics and completion semantics before execution infrastructure is added.

## Phase 1 — Task Creation
**Status: complete**

Deliverables:
- App / Website / Game task creation
- Task specification and instructions
- Preflight analysis
- Predicted tools/services
- Hard budget limit
- Autonomous execution authorization
- Acceptance criteria
- Task persistence and status lifecycle

## Phase 2 — Agent Manager
**Status: complete**

Deliverables:
- App / Website → Niomi
- Game → Konami
- One agent instance per task
- Isolated workspace record
- Dedicated worker record
- Task-scoped tool manifest
- Agent model configuration
- Budget attachment
- Start / heartbeat / cancel / fail / complete lifecycle
- Acceptance-gated completion
- Task chat message channel

## Phase 3 — Worker Runtime & Execution Foundation
**Status: complete**

Deliverables:
- Worker runtime state machine
- Execution-plan and execution-step contracts
- Worker leases and heartbeats
- Checkpoints / resumable state
- Runtime adapter interface
- Controlled local development adapter for testing
- Controlled command execution
- Retry / timeout / cancellation boundaries
- No model-provider coupling yet

## Phase 4 — Niomi / Konami Model Orchestrator
**Status: complete**

Deliverables:
- Per-instance model session state
- Fable execution role
- Astra reasoning/review role
- Shared task blackboard
- Planner → implementer → reviewer coordination
- Context compaction / memory snapshots
- Model failure recovery
- Cost accounting per model action

## Phase 5 — Tool, MCP & Permission Broker
**Status: complete**

Deliverables:
- Central tool registry
- Per-agent tool manifest enforcement
- Scoped permissions and exact authorization scopes
- One-time preauthorization from the task authorization plan
- Credential-reference and expiry abstraction with explicit credential requests
- Tool-call auditing and adapter availability auditing
- Approval boundary for genuinely new permissions

## Phase 6 — Persistence, Recovery & Reliability
**Status: complete**

Deliverables:
- Versioned durable database schema and migrations
- Durable state checkpoints with per-scope versioning
- Worker lease-expiry recovery
- One-active-instance enforcement during recreation
- Resume from the failed worker checkpoint
- Model/session/blackboard/orchestration state carry-forward
- Expiring idempotency claims
- Persistent job queue with deterministic claim filters
- Job leases, retry/backoff policies and lease recovery
- Dead-letter and blocked states
- Recovery event audit records

## Phase 7 — App / Website Execution
**Status: complete**

Niomi capabilities:
- Structured App/Web execution-plan contract
- Repository initialization with Git
- Workspace-scoped frontend/backend file implementation
- Node/npm command execution with allowlisted executables
- Database/auth/service operation adapter boundary
- Browser smoke-test adapter boundary
- Web deployment adapter boundary
- Automated test execution
- Build execution
- Durable execution checkpoints
- Persistent App/Web execution-run records
- Artifact packaging with npm
- Execution result and evidence written to the task blackboard
- Workspace path escape protection

## Phase 8 — Game Execution
**Status: complete**

Konami capabilities:
- Engine-neutral Unity / Unreal / Godot adapter interface
- Configurable engine executable, action and build-command bindings
- Per-agent workspace attachment for engine execution
- Project initialization contracts
- Workspace-scoped asset write/copy pipeline
- Engine action execution
- Configurable automated playtest checks
- Build/cook/package adapter boundary
- Durable game execution checkpoints and run records
- Artifact manifest generation and file inventory
- Game execution evidence written to the isolated agent blackboard
- Engine isolation and workspace escape protection

## Phase 9 — Verification & 100% Completion
**Status: complete**

Deliverables:
- Objective acceptance-criteria evaluator
- Verification runs persisted per task/agent
- Execution evidence inspection
- Unit/integration/e2e result gating
- Test/build/playtest/smoke verification
- Deployment verification when a deployment step exists
- Artifact existence and workspace-boundary verification
- Hard budget verification
- Isolation/security verification
- Failure classification by execution domain
- Completion gate that rejects manual acceptance-only completion

## Phase 10 — User Control Dashboard
**Status: complete**

Deliverables:
- Chat-first control panel
- High-value statuses only
- WORKING / DECISION NEEDED / IMPORTANT UPDATE / BLOCKED / COMPLETED
- User changes while running
- Impact detection
- Budget impact checks
- Task progress
- Deliverables
- Persistent user change requests and dashboard updates
- Safe in-scope changes applied without routine approval
- Scope changes paused for explicit user approval
- Hard-budget impact validation before approval
- Browser dashboard at `/` with task chat, decisions, progress, budget and deliverables
- Complete standalone frontend control center with task creation/preflight, live polling, responsive mobile layout, cancellation, editing, approvals, budget escalation and toast feedback

## Phase 11 — Security, Secrets & Billing
**Status: complete**

Deliverables:
- Provider-neutral secret vault abstraction with reference-only production boundary
- Scoped temporary credential leases with expiry, scope validation and revocation
- Provider billing adapter contract and registry with deterministic test adapter
- Atomic hard-spend reservations and capture enforcement
- Idempotent provider billing charges
- Durable billing ledger and spend provenance
- Redacted append-only audit records for security-sensitive actions
- Tenant and user task isolation with suspended-tenant fail-closed behavior
- Per-tenant active-task, command-rate, tool-call-rate and hourly-spend abuse limits
- Admin token boundary and tenant security controls
- Tenant suspend/resume, limits, credential revocation, task cancellation and audit inspection
- Protected public task mutation surface
- Optional signed principal authentication mode for production request boundaries

## Phase 12 — Production Infrastructure
**Status: complete**

Deliverables:
- Container / microVM runtime adapter contracts with hardened isolation defaults
- Worker pools with CPU/GPU resource classes
- Atomic production job assignment on the existing durable queue
- Worker heartbeats, stale-worker rejection and graceful draining
- GPU worker resource specifications
- Durable database adapter boundary with Postgres transaction support
- Persistent object storage adapter with tenant-scoped artifact namespaces
- Network allow/deny policy with private-network rejection and DNS-resolved checks
- Metrics, infrastructure events and threshold-based alerts
- Runtime-coordinator integration for production assignment recovery and alerts
- Infrastructure control/status APIs

## Phase 13 — RazeKit Integration
**Status: planned**

Only after the standalone DEV system is reliable:
- Integrate into RazeKit
- Reuse RazeKit authentication/user identity
- Connect production payment/storage/deployment services
- Preserve standalone Agent Manager isolation
- Roll out gradually

## Rule for implementation

Do not skip a phase because the next phase is more exciting. Each phase must leave a stable contract that Claude Code can later improve without rewriting the whole system.
