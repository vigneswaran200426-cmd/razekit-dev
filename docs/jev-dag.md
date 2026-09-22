# JEV — the task execution graph

This documents what is implemented, not what is planned. Where something is not
built, it says so.

## Why a graph

Before this, a plan was a flat list of steps run start to finish. That model
cannot express the shape real work has:

```
                    ┌── implement-backend ── test-backend ──┐
inspect ── define ──┤                                        ├── integrate ── verify
                    └── implement-frontend ── test-frontend ─┘
```

The two branches are independent and should run at once. More importantly, when
`implement-backend` fails, `test-backend`, `integrate` and `final-verification`
can never run — and in a list model they simply sit unexecuted while the task
reports neither success nor failure.

## The two halves

**`src/jev-domain.js` is pure.** It takes nodes and returns nodes. No store, no
clock it was not handed, no worker. The rules that decide *may this run yet* and
*what dies when this dies* are the part that must be provable, and a pure
function is the cheapest kind to prove.

**`src/jev.js` is durable.** Every operation runs inside one `transact()`. On
Postgres that takes the engine's advisory lock for the length of the
transaction, so a claim is atomic across processes — this file writes no SQL of
its own and reuses the primitive the job queue already proved.

## Node states

| State | Meaning |
| --- | --- |
| `pending` | dependencies not all satisfied |
| `ready` | every dependency succeeded; claimable |
| `running` | claimed under a lease by exactly one worker |
| `succeeded` | terminal |
| `failed` | ran and failed, with no attempts left or a non-retryable error |
| `skipped` | never ran and never will — something upstream will not succeed |
| `cancelled` | the graph was stopped |
| `timed_out` | exceeded its own deadline |

`skipped` is deliberately not `failed`. The distinction is what lets an operator
see the cause apart from the casualties. `timed_out` is deliberately not
`failed` for the same reason: "too slow" and "broken" need different responses.

## Five decisions worth keeping

**Cycles are rejected before storage.** A cycle does not announce itself at
runtime — every node waits for another node in the cycle, the scheduler finds
nothing ready, and the task sits at "running" with no worker and no error until
a human notices. `assertAcyclic` names the keys involved, because "your graph
has a cycle" is not something anyone can act on.

**Failure propagation runs to fixpoint.** One pass would skip the direct
dependents of a failure and leave *their* dependents pending forever — the same
silent hang as a cycle, reached differently.

**Readiness is re-derived at claim time.** The stored status is a cache; the
dependencies are the truth. If they ever disagree — a partial write, a
migration, a hand-edited row — `claimableNodes` declines to hand out the node
rather than running work whose prerequisites did not pass.

**Every completion is fenced on the lease id.** A worker declared dead, whose
node was reassigned and finished by someone else, must not be able to overwrite
the real result when it wakes up. It is told `accepted: false`, not failed —
from its own point of view nothing went wrong.

**`retryable` is supplied by the caller, never inferred.** Guessing from an
error message is how budget exhaustion previously became an infinite retry loop.

## Worker death vs. node timeout

Two different failures, kept apart on purpose:

| | Meaning | Response |
| --- | --- | --- |
| lease expired | the **worker** is gone | back to `ready` if attempts remain — a killed container is recoverable |
| deadline passed | the **node** is too slow | terminal; retrying would just be slow again |

The deadline is set once, on the first attempt, so a node cannot buy itself more
time by failing.

## Time

Every timestamp comes from the caller, never from the database. The engine host
and Neon were measured **154 seconds apart**; a deadline written by the
application and compared against the database's `now()` expires work that is
still running.

## Audit

Audit rows are appended inside the caller's transaction, not by calling
`writeAudit()` from within one. `writeAudit` opens its own `transact`, and on
Postgres a nested `transact` waits for an advisory lock the outer transaction
still holds — a deadlock, not a slow path. Writing directly is also the stronger
guarantee: the audit row and the state change it describes commit together or
not at all. Node payloads pass through `redactAuditValue`, so a payload carrying
a credential does not reach the audit trail.

## Evidence

| Suite | Store | Result |
| --- | --- | --- |
| `test/jev.test.js` | JSON | 23 pass |
| `test/postgres-jev.test.js` | **real Neon** | 7 pass |

The Postgres suite exists because the JSON store is atomic only within one
process and therefore cannot prove the property that matters: two workers in two
containers never receive the same node. Its central test puts six concurrent
workers against four parallel nodes and asserts four distinct claims, four
distinct leases, `attempt === 1` on every one, and two workers told no.

## Not built yet

- The autonomous loop still executes **flat plans**. Nothing translates a
  planner's step list into a graph, so JEV is not on the live execution path.
- No per-node budget reservation. `budgetMinor` is carried on the node and is
  not yet checked against the ledger.
- No per-node tool-scope enforcement. `toolScopes` is carried and not yet
  handed to the tool broker.
- Queue integration: nodes are claimed by polling `claimNextNode`, not by an
  SQS message.
