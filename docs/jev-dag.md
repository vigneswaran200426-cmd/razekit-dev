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

## Konami

Both production systems run the same node lifecycle. `jev-profiles.js` holds
what genuinely differs:

| | Niomi | Konami |
| --- | --- | --- |
| Runtime | `AppWebRuntime` (service/browser/deploy adapters) | `GameRuntime` (engine/playtest/packager adapters) |
| Plan contract | `normalizeModelExecutionPlan` | `normalizeGamePlan` (requires a top-level engine) |
| Blackboard keys | `execution.*` | `game.execution.*` |
| Run kind | `jev_graph` | `jev_game_graph` |

Less differs than expected: both runtimes already expose the same
`execute(step, context)`, so nothing wraps them. An unknown agent type is
rejected rather than defaulting to App/Web — running a new system through the
wrong runtime fails deep inside a step instead of at the boundary.

A game plan declares its engine once, at the top. The graph stores nodes, not
plans, so the planner stamps the engine onto every payload that did not name
one; otherwise a build node read back from the database has no idea what to
build.

Moving Konami across surfaced three bugs that had nothing to do with graphs and
everything to do with keys hardcoded to App/Web: the orchestrator wrote every
plan to `execution.plan`, so Konami had never received a model plan at all; the
loop's execution gate read the same key, so once the plan was stored correctly
the gate stopped firing; and the deterministic reviewer looked for an App/Web
result and so never passed a game task.

**The loop configures no engine adapters.** An engine or build step fails with
the same "No game engine adapter is configured" it has always failed with.
Moving onto JEV does not invent engine support that was never there.

## Dependency modes

A node normally runs only when everything it depends on has SUCCEEDED, and a
failed dependency SKIPS it. That is the right rule for work, and the wrong rule
for a node whose job is to look at what happened.

`dependsOnMode: "settled"` says: run when the dependencies have finished,
however they finished. It exists for reviews. Under the normal rule a failed
build skipped its own review, so nobody decided what to do about the failure and
the task simply stopped — the opposite of the repair loop the review exists to
drive. A settled-mode node is still doomed by CANCELLED or SKIPPED dependencies,
because those mean the graph is being torn down rather than that something went
wrong.

The rule is re-checked at claim time rather than trusted from the stored READY
status. READY is a cached derivation; a claim must not depend on a cache.

## Reopening a node

`reopenNode` puts a FAILED or TIMED_OUT node back in the queue, and revives the
dependents it had skipped. It is narrow on purpose — a failed node is a fact,
and this is not an "un-fail" — but there are two cases where the reason for the
failure turns out not to have happened: a model call reconciled as never having
reached the provider, and infrastructure since repaired.

The attempt counter is **not** reset. Resetting it would allow an unbounded loop
through repeated reopening, and the count is also the honest record of how many
times this was tried. Reopening raises the ceiling by one, which is visible in
the node rather than hidden in a reset.

## Workers

`src/jev-worker.js` is a process that claims and runs nodes. It shares nothing
with the API except the database, which is the only thing the claim was ever
atomic through:

```
claim (advisory-locked, one winner)
  -> lease (renewed at a third of its length while the work runs)
    -> execute
      -> settle (capture, release, complete or fail)
```

It adds no scheduler. Which node is next is `claimNextNode`'s answer, from the
same transaction the inline path uses.

Three things it does that the inline path never had to:

- **Holds the lease open.** A node that outlives its lease is swept and run
  twice. The renewal timer is released the moment the node settles — a timer
  left running would keep a dead worker's lease alive and stop the sweeper
  recovering it, which is the failure the lease exists to prevent, reintroduced
  by the thing meant to hold it.
- **Sweeps.** Any worker may recover any stalled node. A node abandoned by a
  worker that died is not the dead worker's problem to solve.
- **Stops without abandoning.** A stop signal stops *claiming*. The node in hand
  finishes and settles, because abandoning work that has already been paid for
  to wait out a lease is worse than taking a few more seconds to shut down.

`RAZEKIT_JEV_INLINE_EXECUTION=false` turns the autonomous loop into a pure
coordinator: it creates and expands graphs and decides completion, and runs
nothing. Both modes read the same graph and reach the same decisions — the
switch changes who claims, not what is claimable. It defaults to `true`, because
turning it off without a worker running would leave every graph waiting for a
claimant that does not exist.

The cycle run record — `run.result.plan.steps`, which the verifier and the
dashboard read — is written at the point a node settles, inside the executor.
It used to be written by the caller, which was fine while the caller was always
the thing running the node and silently wrong the moment a worker was.

## Not built yet

- **No engine toolchain is configured**, so Konami's engine, build and playtest
  steps only run where adapters are supplied. `executeGameTask` is retained as
  `runFlatGameExecution` but the live loop no longer calls it.
- Nodes are claimed by polling `claimNextNode`, not by an SQS message.
- Model phases (plan/implement/review) are not themselves graph nodes — only the
  execution plan is. Their spend still goes through the orchestrator.
- No cross-process worker drains a graph in production; `drainGraph` runs
  inline in the loop. The claiming is already safe for it, and nothing runs that
  way yet.
