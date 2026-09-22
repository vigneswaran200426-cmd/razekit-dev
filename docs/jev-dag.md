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

## From a planner's list to a graph

`jev-planner.js` converts the flat plan Fable produces. The derivation is
deliberately conservative, because the list model's contract was "these run in
order" and a graph must not be *weaker* than that:

| Step kind | Depends on |
| --- | --- |
| command, service, smoke, deploy, package, engine action | **every** step before it — the sequential guarantee, kept exactly |
| file write / mkdir / asset write | the most recent barrier, plus any earlier write touching the same path or a directory above it |
| anything unrecognised | every step before it — guessing that an unknown kind is safe to parallelise is the wrong default |

A step that declares its own `dependsOn` bypasses the derivation entirely, so a
model taught the graph shape can express it directly.

The only parallelism introduced is between file writes that never observed each
other in the list model either. `retries` (extra attempts) converts to
`maxAttempts` (total attempts) so a plan does not quietly gain a free try.

## Budget

Each node carries `budgetMinor` — a **ceiling on what it may spend**, not a share
of the task's money. It comes from `RAZEKIT_EXECUTION_RUN_COST`, the same knob
the flat executor used, which still defaults to zero: execution is free by
default and the budget binds by being *checked*, not consumed.

This distinction was found by the tests rather than by reasoning. An earlier
version spread the whole remaining budget across the nodes, which meant the
first build consumed 100% of a task's budget even when execution was free, and
no second build could ever run.

`jev-budget.js` is a translation layer over `billing.js` and adds no ledger of
its own. Everything that enforces a limit — the hard agent budget, the
concurrent-reservation accounting, the tenant hourly ceiling — already lives
there. Per node: reserve before the work, execute, settle after.

Settlement is asymmetric, on purpose:

- **succeeded** captures the reservation, unless the runtime measured less.
- **failed** captures only what was measured, and releases the whole hold when
  nothing was. There is no evidence of cost, and a node can hold a large share
  of the remaining budget — capturing it in full would leave nothing for the
  retry and make `maxAttempts` unreachable by construction.

`captureSpend` was **extended**, not duplicated: passing `actualAmount` captures
that much and releases the rest in the same transaction. Splitting it into a
release plus a fresh charge would open a window where the unused budget is free
for another node while this node's real cost is not yet recorded. Capturing more
than was reserved is refused.

**Known and deliberate:** `billing.js` represents money as JavaScript numbers in
whole currency units. JEV uses integer minor units, and `jev-budget.js` converts
at the single point the two meet. Changing the unit of the existing ledger is a
migration touching every Phase 11 test, not a refactor, so it has not been done.

## Tool scope

A node's `toolScopes` narrow what the agent's permissions already allow; they
can never widen them. The permission broker remains the outer boundary.

- **absent** — no narrowing (the agent's permissions still apply in full)
- **`[]`** — explicitly no tools
- **`[...]`** — only what is listed

Making "absent" mean "nothing" would look stricter and be worse in practice:
every pre-existing node would start failing and the pressure would be to hand
nodes a blanket scope.

The check runs inside `ToolBroker.invoke`, **after** `authorizeToolCall` — so a
call that passes no scopes, and is therefore expanded to the tool's full set,
cannot slip past the narrowing — and **before** any credential is resolved, so a
step outside its scope never causes a secret to be leased on its behalf. The
node must belong to the calling agent's own task, or a node id would be a way to
borrow another tenant's scopes. A denial is audited with `outcome: "failed"`,
because a step reaching for a tool it never declared is a security event.

## Evidence

| Suite | Store | Result |
| --- | --- | --- |
| `test/jev.test.js` | JSON | 23 pass |
| `test/jev-planner.test.js` | pure | 21 pass |
| `test/jev-execution.test.js` | JSON | 21 pass |
| `test/autonomous-loop.test.js` | JSON | 6 pass |
| `test/postgres-jev.test.js` | **real Neon** | 7 pass |
| `test/postgres-engine.test.js` | **real Neon** | 4 pass |

The Postgres suites exist because the JSON store is atomic only within one
process and so cannot prove the property that matters: two workers in two
containers never receive the same node. `postgres-jev` puts six concurrent
workers against four parallel nodes and asserts four distinct claims, four
distinct leases, `attempt === 1` on every one, and two workers told no.

**The live loop runs through JEV.** `autonomous-loop.test.js` drives a real task
from plan to verified completion and then asserts that every execution run is
`kind: "jev_graph"`, that exactly one graph exists, that all its nodes succeeded,
that none is still leased, and that the graph has real dependency edges — so
"it executes through the graph" is checked, not inferred from the task finishing.
`postgres-engine.test.js` drives the same loop to completion against real Neon.

## Not built yet

- **Konami still uses the flat executor.** Game runtimes have their own adapters
  and moving them is separate work; the planner understands game step kinds, but
  the loop routes only Niomi through JEV.
- Nodes are claimed by polling `claimNextNode`, not by an SQS message.
- Model phases (plan/implement/review) are not themselves graph nodes — only the
  execution plan is. Their spend still goes through the orchestrator.
- No cross-process worker drains a graph in production; `drainGraph` runs
  inline in the loop. The claiming is already safe for it, and nothing runs that
  way yet.
