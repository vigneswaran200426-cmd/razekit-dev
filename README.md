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

## Next phases

Phase 4 connects the isolated agent instances to the Niomi/Konami model orchestrator.

Then:
1. Tool + MCP + permission broker
2. Persistent recovery system
3. App/Web execution
4. Game execution
5. Verification / 100% completion
6. User dashboard and live task changes
7. Security, secrets and billing
8. Production worker infrastructure
9. RazeKit integration

See `ROADMAP.md` for the complete phase contract.
