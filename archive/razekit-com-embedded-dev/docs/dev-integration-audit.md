# RazeKit DEV — integration audit

> **Superseded.** This audit assumed the engine lived in the separate
> `razekit-dev` repository. RazeKit DEV is now built in this repository — see
> [`dev-main-repo-audit.md`](dev-main-repo-audit.md) and
> [`../RAZEKIT_DEVELOPMENT_AREA.md`](../RAZEKIT_DEVELOPMENT_AREA.md). Kept for
> its reasoning and blocker history.

Phase 0 discovery. Written from inspection of the running systems on
2026-09-22, not from the specification. Every claim here has evidence behind
it; where something could not be verified, it says so.

---

## 1. Verification results (before any implementation)

The mandate lists a "current known state" and instructs: verify, do not
assume. Results:

| Claim | Verified | Evidence |
|---|---|---|
| Main repo has latest on origin/main | **yes** | `main...origin/main`, no divergence |
| Six earlier commits on origin/main | **yes** | all six contained in `origin/main` |
| Production `/api/development/*` off-switch verified | **yes** | live API returns `404`, identical to a path that was never built; front-end bundle contains 0 occurrences of `/development`, `api/development`, `BuildDetail` |
| Neon PostgreSQL connected | **yes** | `razekit_dev` reachable, PG 18.6, 2 tables |
| AWS MCP connected | **NO — blocked** | `sts:get_caller_identity` → *"This connector requires authentication"*, 5 attempts across 3 sessions |
| OpenAI credential available to runtime | **NO** | `OPENAI_API_KEY` absent; engine `/health` reports `models.mode: "test"` |
| Anthropic credential available to runtime | **NO** | `ANTHROPIC_API_KEY` / `FABLE_API_KEY` / `ASTRA_API_KEY` absent |
| GitHub integration available | **NO** | `GITHUB_APP_ID` absent; `plugin:engineering:github` connector unauthenticated |
| Payment provider credentials | **NO** | `STRIPE_SECRET_KEY`, `RAZORPAY_KEY_ID` absent |
| Higgsfield credential | **NO** | `HIGGSFIELD_API_KEY` absent |

**An API key existing in an account is not the same as a credential reaching
the runtime.** Nine of the eleven external capabilities this mandate depends
on are currently unreachable from the execution environment.

---

## 2. Current architecture

### Main product — razekit.com

| Layer | Implementation |
|---|---|
| Hosting | Render — `razekit-web` (static), `razekit-api` (node), both auto-deploy on `main` |
| Database | Neon project `razekit` (`super-thunder-67772448`), PG 18.6, us-east-2 |
| Admin | separate Render services + separate Neon project `admin-razekit` |
| Backend | Node + TypeScript + Express + Prisma |
| Frontend | Vite + React 18 + React Router + Tailwind |
| Auth | own JWT (`rk_token`), OAuth, OTP; `attachUser` → `req.user` |
| CI | one workflow, `razekit-quality.yml` |
| Tests | 38 server test files, 4 web test files |

### The durable schema is generic, and that matters

Prisma defines **three** models: `Record`, `AppUser`, `AuthOtp`. The entire
product — contests, submissions, payments, payouts — lives in the generic
`Record` table behind `entities/` with an RLS engine.

Consequence for this mandate: §51 asks for typed columns, foreign keys and
constraints. Applying that to the product's own data would be a migration of
every feature RazeKit has, and §66 forbids changing unrelated functionality.
**DEV state therefore must not live in `Record`.** It already does not — see
below.

### RazeKit DEV — current state

Persistence was ported to Postgres in the previous session and is the one
part of the DEV stack that is production-shaped today.

| | |
|---|---|
| Database | its own Neon project `razekit-dev` (`frosty-pond-12955506`), us-east-2 |
| Schema | `razekit_dev.rk_state` (keyed JSONB rows), `razekit_dev.rk_meta` |
| Atomicity | `pg_advisory_xact_lock` inside a real transaction — genuinely cross-process |
| Job claiming | `FOR UPDATE SKIP LOCKED`, outside the global lock |
| Idempotency | enforced by unique index, not by application check-then-insert |
| Tests | 17 against the real Neon database; JSON path unchanged at 92 |
| Store guard | `assertProductionStore()` refuses the file store under `NODE_ENV=production` |

Separate Neon project on purpose: the DEV plane does high-frequency job
claiming, and the product's compute is a 0.25–2 CU instance serving the live
site. This follows the existing `admin-razekit` precedent.

---

## 3. Reusable existing systems — do not rebuild these

This is the most consequential finding of the audit. RazeKit already has
production implementations of several systems the mandate describes as new
work.

### A double-entry ledger already exists — `server/src/ledger/`

Not a balance column. A real ledger with accounts, classes, normal sides,
balance replay, and these operations:

```
getOrCreateAccount   replayBalance      balanceOf        postAdjustment
reservePrize         releasePrize       approveRefund    recordRefundPaid
reserveWithdrawal    releaseWithdrawal  recordPayoutPaid recordFundingVerified
```

It already carries `idempotencyKey`, `actorId`, `actorRole` and reason on
postings.

**§11 (development credit ledger) and §12 (budget governor reserve / capture /
release) map directly onto `reserve*` / `release*` / `postAdjustment`.**
Building a second parallel ledger for development credit would create two
sources of financial truth in one product. The correct work is new
`ACCOUNT_CLASS` and `OWNER_TYPE` entries plus DEV-specific operations on the
existing primitives.

### A fee engine already exists — `server/src/money/fees.ts`

`applyFeeRule`, `computeQuote({ subtotalMinor, platformRule, processingRule,
taxRule, discountMinor })`, `activeRule(rules, ruleType, marketKey, currency)`.

**§10's 15% platform fee is a fee rule, not new arithmetic.** Hard-coding
`× 1.15` anywhere would bypass an engine that already handles market,
currency and rule versioning.

### A payment state machine already exists — `server/src/payments/`

`PAYMENT_STATE`, `canTransition`, `assertTransition`, `GATEWAY_STATE`,
`defineAdapter`/`registerAdapter`/`listAdapters`, `FUNDING` states, and
webhook handling in `uropay.ts` / `manualBeta.ts`.

**§4's payment lifecycle and §55's webhook security should extend this
adapter registry**, not introduce a second payment subsystem.

### Also reusable

| Need | Existing |
|---|---|
| Identity, sessions, roles | `server/src/auth/` (JWT, OAuth, OTP) |
| Tenant/ownership enforcement | `server/src/entities/rls.ts` |
| Object storage + signed URLs | `server/src/integrations/storage.ts`, `files.ts` |
| Upload validation | `integrations/uploadGuard.ts` |
| Rate limiting | `server/src/middleware/rateLimit.ts` |
| Security headers | `server/src/security/headers.ts` |
| Redacted error capture | `server/src/errors/capture.ts` |
| Notifications | `server/src/notify/emit.ts` |
| Social provider adapters | `server/src/social/adapters/` (7 platforms, built by a parallel effort) |
| Scheduler | `server/src/scheduler.ts` |

---

## 4. Conflicting systems

### Two competing integration models

The previous mandate placed the engine in the standalone `razekit-dev`
repository, with the main repo acting as a thin authenticated proxy
(`server/src/development/client.ts` + `routes.ts`, signed HMAC principal).
That is built, tested and deployed-but-disabled.

This mandate states the implementation belongs in the **main** repository and
that `razekit-dev` is reference material.

These are not compatible, and the choice is not cosmetic:

| | Engine stays separate | Engine moves into main repo |
|---|---|---|
| Blast radius of a DEV bug | contained | shares a process with the live marketplace |
| Deploy coupling | independent | every DEV change redeploys the product API |
| Reuse of ledger/auth/payments | across an HTTP boundary | direct function calls |
| Work already done | preserved | ~9 commits of engine work must be migrated |

**Recommendation, for your decision:** keep the *execution engine* separate
(it is the thing that must scale onto Fargate independently and must not be
able to take down the marketplace), and move the *control plane* — task
records, budget, payment, credit ledger, dashboard APIs — into the main repo
where the ledger and auth already live. That satisfies "no duplicate
infrastructure" and "main product unaffected" simultaneously. It is a
different split from either mandate as literally written, so it needs your
confirmation before anything is migrated.

### The DEV area is currently switched off in production

`DEV_AREA_ENABLED` (API) and `VITE_DEV_AREA_ENABLED` (build) both default
false. Verified: production returns 404 and the bundle is clean. This is the
§71 emergency off-switch, already implemented and already proven — it should
be formalised, not rebuilt.

---

## 5. Missing production systems

Nothing below exists yet in any form. Listed with its hard dependency.

| System | Depends on |
|---|---|
| Real service-to-service auth (§7) | — |
| Formal task state machine (§8) | — |
| Real preflight analysis (§9) | Astra credential |
| Payment → execution gate (§10) | payment provider credential |
| Development credit ledger (§11) | existing ledger (available) |
| Hard budget governor (§12) | existing ledger (available) |
| Astra provider (§13) | OpenAI credential |
| Fable provider (§14) | Anthropic credential |
| JEV execution layer (§15) | sandbox → AWS |
| DAG executor (§18) | — |
| Worker pool on Fargate (§19–22) | **AWS** |
| Real sandbox isolation (§23) | **AWS** |
| Network egress control (§24) | **AWS** |
| Secrets Manager (§25) | **AWS** |
| S3 artifacts (§26) | **AWS** |
| SQS (§5) | **AWS** |
| Tool/MCP broker (§28) | — |
| Semantic verification (§30) | execution plane |
| RazeKit Game Runtime (§34) | — |
| Endless Runner Kit (§35) | game runtime |
| Asset Intelligence (§37) | — |
| Higgsfield adapter (§38) | Higgsfield credential |
| PC/mobile build (§39) | game runtime + AWS |
| Dashboard control centre | control-plane APIs |
| Realtime transport | — |
| Social Kit | per-platform credentials |
| Store publishing + compliance | per-store developer accounts |

---

## 6. Security findings

Carried forward from the working system, all currently true:

1. **Unsigned identity headers remain accepted by default.** The engine
   honours `x-razekit-tenant-id` / `x-razekit-user-id` unless
   `RAZEKIT_REQUIRE_SIGNED_PRINCIPAL=true`. Production must set it; a
   deployment that forgets is silently forgeable. §6 requires this be
   impossible, not merely configurable.
2. **`/internal/*` is not a security boundary by itself.** It is currently
   guarded by an admin token on the administrative routes and by the
   main-repo proxy refusing to forward those paths. §7's zero-trust
   requirement is not yet met.
3. **The local process runtime is not a sandbox.** It restricts the
   executable allowlist, the working directory and shell invocation, but runs
   on the host. §23 is unimplemented and cannot be implemented without AWS.
4. **Network policy is advisory.** `network-policy.js` can evaluate a target
   but nothing enforces egress. §24 is unimplemented.
5. **No prompt-injection separation exists.** Repository content, README
   files and tool output are passed to models without a trust boundary
   (§29, Niomi §18, Konami §57).

---

## 7. Persistence findings

The previous session's port is sound and holds under concurrency, but two
limits are known and should be recorded rather than discovered later:

1. **One global advisory lock serialises every transaction.** Correct, and a
   faithful port of the JSON store's single queue, but it does not scale
   past a few tens of workers. The queue already bypasses it via
   `SKIP LOCKED`; other hot paths will need the same treatment. Trigger for
   revisiting: sustained lock wait in `pg_locks`.
2. **Each transaction reads the whole document.** Currently ~28 kB, so
   irrelevant. It grows with history. Trigger: document size past a few MB.

And one measured constraint that drives the AWS region decision:

3. **Round trip from outside the region is ~250 ms**, and a build makes
   hundreds of transactions — the same build is ~4 s on the local JSON store
   and **~204 s** against Neon from a laptop. It is latency-bound, not
   CPU-bound. **Workers must run in us-east-2, beside Neon.**

---

## 8. AWS execution requirements

Cannot be inspected — the connector is unauthenticated. Nothing has been
provisioned and nothing will be until identity, existing resources and IAM
capability have been read (§3F forbids provisioning before inspection, and
§21 forbids duplicating what exists).

When access is available, the first actions are **read-only**: caller
identity, regions, existing VPCs, ECR repositories, S3 buckets, ECS clusters,
SQS queues, IAM roles, CloudWatch groups and Secrets Manager entries. Region
recommendation is **us-east-2**, on the latency evidence above, unless
existing infrastructure is already established elsewhere.

---

## 9. Blocker register

Everything below is blocked on something only you can do. None of it can be
worked around, and none of it will be reported as complete while blocked.

| # | Blocker | Blocks | Needed from you |
|---|---|---|---|
| B1 | AWS MCP connector unauthenticated (5 attempts) | ECS, ECR, SQS, S3, Secrets Manager, IAM, CloudWatch, VPC, sandbox, egress control, worker pool, autoscaling, both golden E2E tests, production certification | Connect it in claude.ai connector settings |
| B2 | No OpenAI credential in runtime | Astra: preflight, planning, DAG generation, review, replanning, failure analysis | Provision `ASTRA_API_KEY` to the execution environment |
| B3 | No Anthropic credential in runtime | Fable: all code generation and targeted repair | Provision `FABLE_API_KEY` |
| B4 | No payment provider credential | Payment verification, the paid-execution gate, platform fee capture, refunds, webhooks | Decide provider, then provision keys + webhook secret |
| B5 | No GitHub App | Repository authorisation, clone, branch, commit, PR, per-tenant repo isolation | Create the GitHub App, provide app id + private key |
| B6 | No Higgsfield credential | Asset generation capability (Konami only; core stays operational without it per §38) | Provide if wanted; otherwise the capability reports unavailable |
| B7 | No store developer accounts | Google Play, App Store, Microsoft Store, Steam submission | Enrol and connect each; several require manual, human-only steps |
| B8 | Integration-model decision open | Whether the engine migrates into the main repo (§4 above) | Your call |

---

## 10. Implementation order

Revised from the mandate's order on one point only: the mandate places
identity (Phase 1) before persistence (Phase 2), but persistence has already
landed and is verified, so it is recorded as done rather than redone.

**Unblocked now — can proceed without you:**

| Order | Work | Why it is unblocked |
|---|---|---|
| 1 | Formal task state machine (§8) | pure domain logic |
| 2 | Signed service-to-service identity (§7) | crypto + config only |
| 3 | Make signed principals mandatory, not optional (§6) | removes a config-dependent hole |
| 4 | Development credit ledger on the existing ledger (§11) | existing ledger is available |
| 5 | Budget governor: reserve → capture → release (§12) | same |
| 6 | Platform fee as a fee rule (§10 accounting half) | existing fee engine |
| 7 | DAG model + scheduler (§18) | pure domain logic |
| 8 | Tool broker contracts (§28) | pure domain logic |
| 9 | Prompt-injection trust boundary (§29) | pure domain logic |
| 10 | Provider adapter shells with truthful unavailable errors (§61) | must fail honestly, not fake |
| 11 | RazeKit Game Runtime foundation (§34) | pure code |
| 12 | Control-plane API contracts for the dashboard | pure code |

**Blocked — will not be started until the blocker clears:**

Everything in §9's table. Provider adapters will be written but cannot be
*verified*, and per §61 an unverified adapter must fail explicitly rather
than return a fake success.

---

## 11. Scope note

This mandate spans roughly 120 numbered phases across five systems: the DEV
platform, Niomi, Konami plus a from-scratch game runtime, the dashboard, the
Social Kit, and payments/publishing/compliance across four storefronts.

That is a multi-quarter programme for a team. It will be delivered
incrementally, in the order above, with each phase carrying its own tests and
evidence. Progress will be reported as IMPLEMENTED / VERIFIED / CONFIGURED
BUT NOT VERIFIED / BLOCKED, and never as complete on the strength of an
interface existing.
