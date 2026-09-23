# RazeKit DEV — remaining-program progress

Durable state for the remaining completion program. A session that is
interrupted reads this file, inspects the repository, and continues from the
last verified phase rather than restarting.

Completion states are used literally. `VERIFIED` is never claimed because a
build passed, and never claimed for anything an external dependency prevents
executing.

---

## Current phase

**Phase 8/9/12 — multi-process worker execution and recovery.** The worker
loop is proven in one process; its claim/lease primitives are proven
cross-process against Neon. What is not proven is several OS processes running
the loop concurrently against one database.

## Completed in this program

| # | Phase | State | Evidence |
|---|---|---|---|
| 13b | **Dynamic replan of a running graph** | VERIFIED | `test/jev-replan.test.js` — 10 tests: completed nodes are byte-for-byte unchanged, a second change folds into a pending one, sequential changes each get their own cycle, a failed build still accepts a change, a cancelled graph refuses one, and a replan widens neither authorization nor budget |

## Carried in from the previous program (re-verified, not rebuilt)

Live model graph · `MODEL_VERIFY` · repair-cycle governor · UNKNOWN +
reconciliation · bounded context · task lifecycle · execution levels ·
authorization prediction · runtime permission escalation · user-action surface ·
instruction versions · change impact · live JEV graph in the Control Center ·
worker-process execution · Konami on JEV.

The addendum lists §1 (loop on JEV), §2 (MODEL_VERIFY) and §3 (repair governor)
as open. They were closed in `bf27972` and are covered by
`test/live-model-loop.test.js`; they were re-run, not rebuilt.

## Not started

Live preview · payment core and UroPay · admin finance · cloud IaC · worker
pools · load testing · real provider execution against credentials · GitHub and
CI · Konami engine toolchain · Kit · premium UI · Dev Department.

## Tests

| Suite | Result |
|---|---|
| Local (`npm test`) | 303 tests — 272 pass, 0 fail, 31 skipped |
| Real Neon | 27 pass, 0 fail at schema 9 |

## Blocked external

| Dependency | Blocks |
|---|---|
| OpenAI API key | any real Astra call |
| Anthropic API key | any real Fable call |
| `razekit-dev-automation` policy + credential | all AWS provisioning |
| GitHub App | repository operations and CI |
| Game engine toolchain | any real Konami engine build |
| UroPay production credentials | live payment |

## Next exact action

Multi-process worker recovery against real Neon: spawn two `src/jev-worker.js`
processes, kill one mid-node, and assert the other completes it with no
duplicate settlement. The primitives are proven; the processes are not.
