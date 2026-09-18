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
**Status: planned**

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
**Status: planned**

Deliverables:
- Central tool registry
- Per-agent tool manifests
- Scoped permissions
- One-time authorization scopes
- OAuth / temporary credential handling
- Tool-call auditing
- Approval boundary for genuinely new permissions

## Phase 6 — Persistence, Recovery & Reliability
**Status: planned**

Deliverables:
- Durable database schema
- State checkpoints
- Worker crash recovery
- Instance recreation
- Resume from last safe checkpoint
- Idempotent operations
- Job queue
- Retry policies
- Dead-letter / blocked state

## Phase 7 — App / Website Execution
**Status: planned**

Niomi capabilities:
- Repository initialization
- Frontend/backend implementation
- Database setup
- Auth
- Browser automation
- Automated tests
- Build
- Deployment
- Smoke tests
- Result packaging

## Phase 8 — Game Execution
**Status: planned**

Konami capabilities:
- Unity / Unreal / Godot adapter layer
- Project initialization
- Asset pipeline
- Gameplay implementation
- Automated playtesting
- Build/cook/package
- Game artifact delivery

## Phase 9 — Verification & 100% Completion
**Status: planned**

Deliverables:
- Acceptance-criteria evaluator
- Unit/integration/e2e testing
- Build verification
- Deployment verification
- Artifact verification
- Failure classification
- Completion gate

## Phase 10 — User Control Dashboard
**Status: planned**

Deliverables:
- Chat-first control panel
- High-value statuses only
- WORKING / DECISION NEEDED / IMPORTANT UPDATE / BLOCKED / COMPLETED
- User changes while running
- Impact detection
- Budget impact checks
- Task progress
- Deliverables

## Phase 11 — Security, Secrets & Billing
**Status: planned**

Deliverables:
- Secret vault abstraction
- Scoped temporary credentials
- Provider billing adapters
- Hard spend enforcement
- Audit logs
- Tenant isolation
- Abuse limits
- Admin controls

## Phase 12 — Production Infrastructure
**Status: planned**

Deliverables:
- Real containers / microVMs
- Worker pools
- Queueing
- GPU worker class for games
- Persistent storage
- Object storage
- Network isolation
- Observability
- Alerting

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
