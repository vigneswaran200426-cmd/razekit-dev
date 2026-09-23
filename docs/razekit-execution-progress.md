# RazeKit DEV — execution progress

Durable state for the master completion program. A session that is interrupted
reads this file, inspects the repository, and continues from the last verified
phase rather than restarting.

Completion states are used literally:

| State | Means |
|---|---|
| `DESIGNED` | Decided, written down, no code |
| `IMPLEMENTED` | Code exists |
| `TESTED` | Automated tests exercise it |
| `VERIFIED` | Tests prove the property that matters, against real infrastructure where one exists |
| `BLOCKED_EXTERNAL` | Code is as complete as it can be; a credential, account or toolchain is missing |
| `UNVERIFIED` | Code exists and nothing proves it works |

`VERIFIED` is never claimed because a build passed.

---

## Current phase

**Phase 13 — running-task changes.** A user changing an active task should get
an impact analysis, a preview, a new instruction version and a replan — never a
mutated historical record.

## Completed

| # | Phase | State | Evidence |
|---|---|---|---|
| — | JEV DAG (durable graph, leases, recovery, cancellation, audit) | VERIFIED | `test/jev*.test.js`, `test/postgres-jev.test.js` against Neon |
| — | Niomi execution on JEV | VERIFIED | `test/autonomous-loop.test.js` |
| — | Konami execution on JEV | VERIFIED | `test/konami-loop-e2e.test.js` |
| — | Model phases as graph nodes | VERIFIED | `test/jev-model-nodes.test.js`, `test/jev-model-e2e.test.js` |
| 1 | **Live model graph — `advanceAgent` drives the model nodes** | VERIFIED | `test/live-model-loop.test.js` |
| 2 | **`MODEL_VERIFY` as a real node over real evidence** | VERIFIED | same file: the node carries the verification record and cannot overturn it |
| 3 | **Bounded repair cycles** | VERIFIED | same file: limit 2 produces exactly one repair, then `NEEDS_REVIEW` |
| 6 | Model budgeting: estimate → reserve → call → capture → release | VERIFIED | reservation observed from inside the provider call |
| 7 | Model cost estimation (min/expected/max/confidence) | IMPLEMENTED | `jev-model-domain.js`; confidence is deliberately 0.35 with no provider pricing configured |
| 4 | **Provider UNKNOWN outcome and reconciliation** | VERIFIED | `test/model-reconciliation.test.js`: durable record, no retry, provider lookup when the adapter supports one and an honest "unsupported" when it does not, resolve-and-resume through `reopenNode` |
| 5 | **Bounded model context** | VERIFIED | `test/model-context.test.js`: core survives every level of compaction, transcripts never forwarded, over-budget reported rather than trimmed |
| 8 | **Task creation lifecycle** | VERIFIED | `test/task-lifecycle.test.js` and `test/task-api.test.js`: a preview creates nothing and grants nothing; a task cannot be created without a confirmed one; tools added after the preview are refused |
| 9 | **Execution levels (LOW / MID / HIGH / CUSTOM)** | VERIFIED | same files: a higher level is a wider envelope, never a pre-approval for deployment or a data write; a custom policy is validated whole or rejected whole |
| 10 | **Authorization prediction** | VERIFIED | same files: prediction is labelled as prediction, reads the request rather than calling a paid model, and never becomes an authorization without a matching confirmation |
| 11 | **Runtime permission escalation** | VERIFIED | `test/user-actions.test.js`: an approval is a single use by default, a step-scoped one does not leak to another step, only a task-scoped one widens the standing authorization, and approving reopens the step that was refused |
| 12 | **User action surface** | VERIFIED | same file, plus the Control Center: permission, credential, decision, reconciliation and budget waits in one list, blocking first, tenant-scoped. Verified in a browser — a blocked task shows the request, "Allow once" grants exactly one use, the next attempt asks again. |
| 25 | **Worker-process execution** | VERIFIED | `test/jev-worker.test.js`: a worker claims, holds its lease through a node that outlives it, recovers a node another worker abandoned, stops without abandoning, and runs a whole task while the loop only coordinates. Cross-process claiming is proven separately against Neon. |

## In progress

Nothing.

## Not started

Phases 13–24 (running-task changes, Control Center, live preview, payment core, UroPay, payment security,
reconciliation, payouts, admin finance, admin control centre), 26–28 (cloud,
worker pools, scale), 29–32 (real providers, Konami engine, Kit), 33–39 (UI),
40–42 (Dev Department, notifications), 43–47 (resilience, idempotency,
tenant/tool/payment security sweeps), 48–66.

## Blocked external

| Dependency | Status | Blocks |
|---|---|---|
| OpenAI API key | `BLOCKED_EXTERNAL` | Any real Astra call. Every model path today runs deterministic or test adapters. |
| Anthropic API key | `BLOCKED_EXTERNAL` | Any real Fable call. |
| `razekit-dev-automation` permissions + credential | `BLOCKED_EXTERNAL` | All AWS provisioning. The IAM user exists with no policy and no key. |
| GitHub App | `BLOCKED_EXTERNAL` | Repository operations on the user's behalf. |
| Game engine toolchain | `BLOCKED_EXTERNAL` | Any real Konami engine build. Orchestration is proven; no engine has executed. |
| UroPay production credentials | `BLOCKED_EXTERNAL` | Live payment. Not requested yet — code-side work comes first. |

A single consolidated handoff is produced once code-side work is exhausted, not
phase by phase.

## Tests

| Suite | Result |
|---|---|
| Local (`npm test`) | 283 tests — 252 pass, 0 fail, 31 skipped (the skips are the Postgres suites without `RAZEKIT_DATABASE_URL`) |
| Real Neon | 27 pass, 0 fail, at schema 8 |

## Known defects and weaknesses

- **Money is a float inside `billing.js`.** JEV works in integer minor units and
  converts at one boundary (`jev-budget.js`). Changing the ledger's unit is a
  migration, not a refactor. Recorded, not fixed.
- **An unpriced model node reserves nothing.** With `RAZEKIT_MODEL_NODE_COST`
  unset — the default — the estimate is zero, so reserve-before-call holds no
  money. The measured cost is still recorded after the call, and the headroom
  check refuses a node when the budget is already exhausted, so the hard limit
  still binds; but the reservation only *precedes* the spend in a deployment
  that has configured a cost.
- **An overrun is recorded after the fact.** When a provider charges more than
  was reserved, the excess is charged directly and the task stops. That is
  honest, not ideal; the ideal is an estimate that was not too low.
- **No provider-side reconciliation is possible with a real provider yet.** The
  lookup path exists and is tested against an adapter that implements it, but
  neither OpenAI nor Anthropic exposes a general "did this request succeed"
  query, so in practice a real UNKNOWN needs a person. The code says so instead
  of guessing.
- **Resolving a reconciliation moves no money.** When a call provably never
  happened, the capture made on the pessimistic assumption stands and the amount
  a reversal would be for is recorded (`reversalOwedMinor`). Reversing it is a
  finance action with its own authority; inventing one here would be the fake
  refund this codebase refuses to write elsewhere.
- **The worker loop is proven in one process.** Its claim/lease/recovery
  primitives are proven cross-process against Neon, but the worker LOOP itself
  has not been run as several OS processes against Neon simultaneously. That is
  a load-test, and it belongs with Phase 28.
- **`drainGraph` is still the inline path.** It is unchanged and still used by
  tests and by single-process deployments; the worker is the alternative, not
  yet the only way.

## Next exact action

Phase 13 — running task changes. `submitUserCommand` already analyses a change and can require
approval; what is missing is the instruction VERSION (historical records are
never mutated), the impact analysis covering permissions and budget as well as
requirements, and the replan that turns an approved change into new graph nodes
rather than a restarted task.
