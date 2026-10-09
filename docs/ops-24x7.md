# The two 24/7 systems, the model gateway and the Admin Control Center

## Pieces

| Piece | Module | Runs as |
|---|---|---|
| **System A — RazeKit DEV Builder** | `src/ops-supervisor.js` + `src/ops-builder.js` | `node src/ops-supervisor.js --system=builder` |
| **System B — Runtime Operations and Auditor** | `src/ops-supervisor.js` + `src/ops-auditor.js` | `node src/ops-supervisor.js --system=auditor` |
| Shared inference gateway (two model slots, GPU start/stop, budget) | `src/inference-gateway.js`, `src/ollama-client.js`, `src/gpu-controller.js` | `node src/inference-gateway.js` |
| Niomi / Konami on local models | `src/adapters/ollama-gateway-adapter.js` | inside the DEV server, when `RAZEKIT_AGENT_MODEL_PROVIDER=gateway` |
| Browser tool (Playwright, policy-enforced, audited) | `src/ops-browser.js` | inside System A / Niomi |
| Admin Control Center | `src/admin-ops-page.js`, `src/admin-ops-api.js` | DEV server, `GET /admin/24-7`, `/api/admin/ops/*` |
| State | `src/ops-state.js` | the existing store; additive `ops*` collections (schema 11) |

System A and System B are the same runtime with different handlers and
different permissions, run as two OS processes. Each has its own process
lease (a second copy stands down), its own task queue, control requests,
checkpoints, workspace, log file and environment file. Neither can see the
other's secrets: a supervisor refuses to boot if it can (`assertIsolation`).

Niomi and Konami are not supervisors. They are the product agents advanced by
the DEV server's runtime coordinator; the admin page can pause and resume each
of them, and the coordinator — not the HTTP handler — applies that.

## What "running" means

A status is derived on the server from the newest heartbeat and its age
(`deriveProcessStatus`): `running`, `starting`, `paused`, `stopping`, `failed`
only from a fresh heartbeat; `stale` once late; `offline` once old or after a
clean shutdown; `not_configured` if no process ever reported. Nothing is shown
as running because a page loaded.

A control (Start, Pause, Resume, Stop Current Task, GPU start/stop, agent
pause/resume) is a durable request: `requested` → `accepted` (by a named
process) → `completed` with evidence, or `failed`, or `expired` when no live
process accepted it. The page shows exactly that sequence.

## Reliability

- Restart recovery: mode, queue, checkpoints and requests are persisted; a new
  process reads its mode and resumes interrupted tasks from their last checkpoint.
- Task leases with renewal; expired leases are recovered on the next claim and
  dead-lettered when attempts run out. A process that loses its lease stops.
- Retries with exponential backoff; per-task timeouts.
- Duplicate prevention: idempotency keys (per active task, or forever for
  schedule slots) and one live process per system.
- Interruptions (pause, emergency stop, shutdown) return the task to the queue
  without consuming an attempt.
- Watchdog: a loop that stops completing iterations exits so systemd restarts it.
- Postgres client: keepalive and a query timeout, so a dropped connection
  fails instead of hanging.
- Emergency stop: a persisted flag read by both supervisors, the gateway and
  the agent coordinator on every loop.
- Logs and audit records are redacted before storage (`redactText`/`redactValue`).

## Models

| Slot | Default | Registry facts (verified 2026-10-09 against registry.ollama.ai) |
|---|---|---|
| coding | `qwen3-coder:30b` | 18.56 GB, Apache-2.0, tools, 256K max context |
| reasoning | `gpt-oss:20b` | 13.79 GB, Apache-2.0, tools + thinking, 128K max context |
| alternative (not assigned) | `devstral-small-2:24b` | 15.18 GB, Apache-2.0, tools |

Both run at a 16K context. They do not fit a 24 GB GPU together, so the
gateway evicts any other model before loading the one a request needs. A model
is shown as *installed* (in `ollama list`), *loaded* (in `ollama ps`, with its
VRAM) and *tested* (a request where the model itself called the test tool, or
a passed acceptance test) — three separate facts.

Acceptance tests (System A tasks `model.coding_test`, `model.reasoning_test`):
the coding model must inspect a fixture repository with tools, edit a file and
leave the real test run green; the reasoning model must plan, and reject a diff
that removes an admin authorization check, citing both the safety problem and
the failing test.

## Running locally

```sh
RAZEKIT_STORE=postgres RAZEKIT_DATABASE_URL=... node src/ops-supervisor.js --system=builder
RAZEKIT_STORE=postgres RAZEKIT_DATABASE_URL=... node src/ops-supervisor.js --system=auditor
RAZEKIT_STORE=postgres RAZEKIT_DATABASE_URL=... RAZEKIT_OLLAMA_URL=http://127.0.0.1:11434 node src/inference-gateway.js
```

The supervisors refuse the JSON store outside tests: it is per-process, so a
supervisor beside a server would be supervising a private copy.

Deployment on AWS: `infra/aws/control-plane/README.md`.
