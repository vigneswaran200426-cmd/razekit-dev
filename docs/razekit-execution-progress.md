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

**Phase 4 — provider UNKNOWN outcome / reconciliation.** Detection, refusal to
retry and the durable reconciliation record are done; the operator-facing
reconcile-and-resume path is not.

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

## In progress

| # | Phase | State | What remains |
|---|---|---|---|
| 4 | Provider UNKNOWN outcome | IMPLEMENTED | Detection, no-retry, reservation captured, `model.reconciliation.pending` written. No operator reconcile-and-resume action yet, and no provider-side lookup (needs a real provider). |

## Not started

Phases 5 (context compaction), 8–24 (task lifecycle, execution levels,
authorization prediction, runtime permission, user actions, running-task
changes, Control Center, live preview, payment core, UroPay, payment security,
reconciliation, payouts, admin finance, admin control centre), 25–28 (worker
process, cloud, worker pools, scale), 29–32 (real providers, Konami engine,
Kit), 33–39 (UI), 40–42 (Dev Department, notifications), 43–47 (resilience,
idempotency, tenant/tool/payment security sweeps), 48–66.

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
| Local (`npm test`) | 240 tests — 209 pass, 0 fail, 31 skipped (the skips are the Postgres suites without `RAZEKIT_DATABASE_URL`) |
| Real Neon | run separately with `RAZEKIT_DATABASE_URL` set; see the commit message for the figure at that commit |

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
- **No provider-side reconciliation.** An UNKNOWN outcome stops the task and
  records what to reconcile. Nothing queries the provider, because there is no
  provider credential to query with.
- **`drainGraph` still runs inline.** Worker-process execution (Phase 25) has
  not started.

## Next exact action

Phase 5 — bounded context compilation for model nodes: `compileModelContext`
already passes only the task, the node's instruction and its dependencies'
structured outputs, but it passes the entire blackboard alongside them and has
no size ceiling. Add the ceiling and the summarise-and-recompile path.
