# RazeKit DEV

Standalone foundation for autonomous app/web and game development agents.

## Phase 1 — Task Creation

- App / Website / Game task types
- Preflight analysis
- Estimated budget + hard maximum budget
- Explicit autonomous-execution authorization
- Acceptance criteria
- Persistent task state
- Task progress endpoint

## Phase 2 — Agent Manager

### Agent routing

- App → **Niomi**
- Website → **Niomi**
- Game → **Konami**

Every task receives its own independent agent instance. The instance has separate task state, workspace, worker, tool manifest, model configuration and budget ceiling.

### Lifecycle

`ready_for_agent → queued → running → completed | cancelled | failed`

Authorized task creation now automatically provisions and starts its agent.

### Isolation

- Workspace is created under `RAZEKIT_WORKSPACE_ROOT/<taskId>`.
- Local state writes are serialized.
- Database writes use a temporary file + atomic rename.
- Multiple tasks cannot share the same agent instance/workspace/worker records.

### Budget

Every agent has a hard budget ceiling. Spending must go through the budget manager and is rejected when the ceiling would be exceeded.

### Dashboard / API

The prototype includes:

- Task creation + preflight
- Agent list/details
- Task progress
- Task chat messages
- Agent heartbeat
- Manual spawn/start/process-ready
- Cancellation/completion
- Budget check + charge endpoints
- Health endpoint

### Tests

```bash
npm test
```

The test suite covers routing, per-task isolation, hard budget enforcement, completion cleanup and persistence.

## Important execution boundary

This repository now has the orchestration layer, but the real model/tool execution adapter is intentionally separate. Production execution still needs a secure worker runtime, scoped credentials/secrets, model API adapters, MCP/tool adapters, build environments, sandboxing and external billing integration.

That separation is deliberate: Claude Code can replace the runtime adapter later without rewriting task creation or Agent Manager state.
