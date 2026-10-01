# Durable payment reconciler — STEP 0 plan

> Branch `fix/economic-payment-reconciler` · economic-service · follow-up to D-035 (docs/23) and
> PR #121 round 2, finding 2. **Plan only. Nothing here is implemented yet.** Only
> `MockPaymentProvider` exists; nothing in this plan connects to a bank or moves real money (ADR-024).

All `file:line` references are against `origin/main` at `acb17db`.

## 1. What exists today

### 1.1 States

`PaymentIntentStatus` = `CREATED | AUTHORIZED | CAPTURED | FAILED | REFUNDED`
(`services/economic-service/prisma/schema.prisma:615-621`). `ck_payment_intent_lifecycle`
(`prisma/migrations/20260828202043_init_economic/migration.sql:806-813`) requires a timestamp for each
state. There is **no `REFUND_PENDING` state**: docs/23 D-035 names it as future work. "Captured, not
credited" is not a state. It is `status = AUTHORIZED` with `failure_reason = 'CAPTURED_NOT_CREDITED'`
(`payment.service.ts:850`, written at `:506-527`).

### 1.2 Transitions (all in `src/payment/payment.service.ts`)

| Step                                                  | Where                                | Transaction boundary                 |
| ----------------------------------------------------- | ------------------------------------ | ------------------------------------ |
| create `CREATED` + balance reservation                | `:136-163`                           | tx 1 (wallet row lock)               |
| `provider.authorize`                                  | `:165-172`                           | **outside any tx**                   |
| `FAILED` on decline                                   | `:174-182` → `fail()` `:661-714`     | tx                                   |
| `AUTHORIZED` + `PAYMENT_AUTHORIZED`                   | `:187-213`                           | tx 2                                 |
| `provider.capture`                                    | `:222-230`                           | **outside any tx**                   |
| `FAILED` on capture decline                           | `:232-240` → `fail()`                | tx                                   |
| `CAPTURED` + ledger credit + `PAYMENT_COMPLETED`      | `completeCapture` `:555-650`         | tx 3 (intent lock → wallet lock)     |
| read back after an ambiguous commit                   | `committedCapture` `:320-339`        | own tx, intent `FOR UPDATE`          |
| uncreditable → provider refund `:uncredited`          | `returnUncreditedCapture` `:476-543` | refund outside tx                    |
| refund failed → mark + `PAYMENT_CAPTURE_UNRECONCILED` | `:503-540`                           | tx                                   |
| same-key retry                                        | `resume` `:401-452`                  | —                                    |
| operator refund: `provider.refund`                    | `refund` `:742-756`                  | **outside any tx**                   |
| operator refund: ledger reversal → `REFUNDED`         | `:758-812`                           | tx (wallet lock); **emits no event** |

`getStatus` already exists on the port (`src/payment/provider.ts:106`, as ADR-024 specifies), and the
mock implements it (`mock.provider.ts:149-152`). **Nothing calls it.** It is also keyed by
`providerReference`, which is not stored until tx 2.

### 1.3 Outcomes that can stay unknown, and the failure that leaves each one

"Retry" means a client retry with the same idempotency key. The API idempotency store releases its
claim on error, so the retry reaches `resume`.

| #   | Failure                                                        | Row left                               | Provider may be                | What a retry does                                                                              | Announced?  |
| --- | -------------------------------------------------------------- | -------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- | ----------- |
| U1  | crash, timeout or hang in `authorize` (`:165`)                 | `CREATED`, no `provider_reference`     | nothing, or `AUTHORIZED`       | refused, "being reconciled" (`:433-438`), **forever**                                          | no          |
| U2  | `authorize` OK, tx 2 fails or crash (`:188`)                   | `CREATED`                              | `AUTHORIZED`                   | refused forever                                                                                | no          |
| U3  | timeout, throw or crash in `capture` (`:222`)                  | `AUTHORIZED`, no marker                | `AUTHORIZED` or **`CAPTURED`** | refused forever                                                                                | no          |
| U4  | capture declined, then `fail()` write fails                    | `AUTHORIZED`                           | `FAILED`                       | refused forever                                                                                | no          |
| U5  | tx 3 fails and the read-back fails (`:280-287`)                | `AUTHORIZED`, no marker                | **`CAPTURED`**                 | refused forever                                                                                | no          |
| U6  | `:uncredited` refund **throws** (timeout) (`:489-501`)         | `AUTHORIZED` + `CAPTURED_NOT_CREDITED` | **`REFUNDED`** or `CAPTURED`   | **credits the wallet without asking the provider** (`:440-447`)                                | yes (event) |
| U7  | refund failed, then the mark tx (`:506`) fails                 | `AUTHORIZED`, no marker                | `CAPTURED`                     | refused forever                                                                                | no          |
| U8  | refund OK, then `fail()` write fails (`:542`)                  | `AUTHORIZED`                           | `REFUNDED`                     | refused forever                                                                                | no          |
| R1  | timeout, throw or crash in operator `provider.refund` (`:742`) | `CAPTURED`                             | `REFUNDED` or `CAPTURED`       | a same-key retry finishes it (provider key `…:refund` is stable) — **only if someone retries** | no          |
| R2  | provider refunds, then the ledger tx is refused (`:758-812`)   | `CAPTURED`, wallet still credited      | **`REFUNDED`**                 | same refusal every time                                                                        | no          |

Consequences beyond the stuck row:

- **U1–U5 and U7 hold reserved headroom for good.** The reservation sums every `CREATED` and
  `AUTHORIZED` intent (`:140-145`), so a stuck intent lowers the wallet's top-up limit permanently.
- **U6 is a live double-value path.** A thrown refund is treated as refused (`() => false`,
  `:500`). If the provider did refund, a later retry credits the wallet too (`resume` `:440-447`). The
  payer gets the money back **and** the wallet is credited.
- **R2 is deterministic, not a crash case.** `assertSufficient` (`:762`) runs **after**
  `provider.refund` (`:742`). If the top-up has been spent, the provider refunds, then the ledger
  refuses with `INSUFFICIENT_BALANCE`. The payer is refunded and the wallet keeps the credit. The
  controller documents "refused when the money has since been spent", but the provider has already
  acted by then.
- There is **no timeout on any provider call.** A hanging provider hangs the request. Once a
  reconciler exists, a timeout simply turns a hang into an unknown outcome that it resolves.

I will confirm U1–U8 and R1–R2 with failing integration tests before fixing them. R2 and U6 do not
need a crash to reproduce: R2 needs a spend between top-up and refund, and U6 needs a refund that
throws.

## 2. Design

### 2.1 Principle: the durable marker exists before the provider is called

Every intent is **scheduled for reconciliation from the moment it is written**, in the same
transaction:

- tx 1 writes `reconcile_state = 'SCHEDULED'` and `next_reconcile_at = now + grace`;
- every transition to a terminal status (`CAPTURED`, `FAILED`, `REFUNDED`) sets
  `reconcile_state = 'NONE'` in **the same transaction** as the status change.

A crash at any point therefore leaves a row the reconciler will find. The reconciler never needs to
infer that something might be stuck. The grace period (config) keeps it away from requests that are
still in flight; correctness does not depend on the grace period (see § 2.4).

The operator refund becomes two-phase in the same way, so R1 and R2 cannot strand anything:

1. **tx A:** intent lock, then wallet lock; `assertSufficient` (moved before the provider call);
   place a `WalletHold` for the amount through the existing hold path (ADR-034; ledger-visible
   `FUNDS_HELD`) so the money cannot be spent while the provider is asked. Then
   `status = REFUND_PENDING`, `refund_requested_at`, and `SCHEDULED`.
2. `provider.refund`, outside any tx.
3. **tx B:** refunded → release the hold, `ledger.reverse` of the top-up journal (the same call as
   today, `:780`), `REFUNDED`, a new `PAYMENT_REFUNDED` event, `NONE`. Declined → release the hold
   and return to `CAPTURED` with a new `PAYMENT_REFUND_FAILED` event.

   A throw or timeout does nothing and leaves the reconciler to decide.

The hold is my recommendation, and it is **Q-A** below. Without it, a spend can still land between
tx A and the provider call, so R2 becomes rare instead of impossible (it would then end in
escalation, not silence).

### 2.2 Schema (one migration, reversible, with `down.sql`)

- `PaymentIntentStatus` gains `REFUND_PENDING`. `ck_payment_intent_lifecycle` gains
  `status <> 'REFUND_PENDING' OR (captured_at IS NOT NULL AND refund_requested_at IS NOT NULL)`.
  PostgreSQL cannot drop an enum value, so `down.sql` recreates the type. It refuses, with a hint,
  if any row is still `REFUND_PENDING`, following the refuse-on-data pattern of
  `20260924120000_transaction_source_fact_unique`.
- New columns on `payment_intent`:
  - `reconcile_state` (`NONE | SCHEDULED | ESCALATED`, default `NONE`; the backfill schedules
    existing non-terminal rows);
  - `next_reconcile_at timestamptz`;
  - `reconcile_attempts int NOT NULL DEFAULT 0`;
  - `reconcile_last_outcome text` (a code only, S-09);
  - `reconcile_lease_until timestamptz`;
  - `escalated_at timestamptz`;
  - `refund_requested_at timestamptz`.

  A CHECK keeps them coherent: `SCHEDULED` requires `next_reconcile_at`, and `ESCALATED` requires
  `escalated_at`.

- Index: a **partial** index
  `payment_intent (next_reconcile_at) WHERE reconcile_state = 'SCHEDULED'`. It is small, because
  only live rows are in it, and it stays bounded as history grows. It is deliberately
  cross-tenant: the scan is a system job, not a tenant query. It needs an entry in
  `EXEMPTIONS.economic` in `scripts/check-tenant-index-order-lib.mjs` with that reason, **or** I
  lead with `organization_id` and scan per tenant. I recommend the exemption, because a per-tenant
  loop turns one index range scan into N. **Your call.**
- Migration verifier: `node scripts/verify-migration-reversible.mjs economic` (up → down → up) and
  `pnpm test:tenant-index-order`.

### 2.3 Provider port (ADR-024 amendment, so an ADR number is needed)

`getStatus(providerReference)` cannot answer U1 or U2, because no reference is stored yet, and it
conflates the payment state with the refund state. Proposed:

```ts
getStatus(query: { paymentIntentId: string; providerReference?: string; idempotencyKey: string }):
  Promise<{
    payment: 'NOT_FOUND' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'UNKNOWN';
    refund: 'NONE' | 'PENDING' | 'REFUNDED' | 'FAILED' | 'UNKNOWN';
    providerReference?: string;
    failureCode?: string;   // code only, through failureCodeFrom (S-09)
    simulated: boolean;
  }>;
```

A real provider looks up by our merchant reference, `paymentIntentId`. `NOT_FOUND` is trusted as
"never reached the provider" only when the adapter declares `authoritativeNotFound`; otherwise it is
treated as `UNKNOWN`.

`MockPaymentProvider`:

- indexes its in-memory map by `paymentIntentId` as well as by reference;
- records refund outcomes, including failures (today `refund` does not record them, `mock.provider.ts:132-147`);
- answers `UNKNOWN` for anything it has not seen, and does not declare `authoritativeNotFound`. After
  a restart it honestly knows nothing (its own comment, `mock.provider.ts:58-68`);
- gains **lost-response directives** so tests can reach U1–U8 and R1 deterministically:
  `lose-authorize`, `lose-capture` and `lose-refund` apply the effect and then throw. `hang-*`
  exercises the new call timeout. These use the same closed-set parsing as today (`mock.provider.ts:81-91`);
  nothing caller-controlled reaches storage.

A provider-call timeout (`ECONOMIC_PAYMENT_PROVIDER_TIMEOUT_MS`) wraps every port call in the
service. It is not in the mock.

### 2.4 The reconciler: `PaymentReconciler`, in `src/payment/`

**Scan and claim.** A short transaction, and the only query that runs unscoped (`runUnscoped` with a
reason, as `balance-audit.ts` does):

```sql
UPDATE payment_intent SET reconcile_lease_until = now() + $lease, reconcile_attempts = reconcile_attempts + 1
WHERE id IN (
  SELECT id FROM payment_intent
  WHERE reconcile_state = 'SCHEDULED' AND next_reconcile_at <= now()
    AND (reconcile_lease_until IS NULL OR reconcile_lease_until < now())
  ORDER BY next_reconcile_at LIMIT $batch
  FOR UPDATE SKIP LOCKED)
RETURNING id, organization_id;
```

This is bounded by `$batch`, indexed by § 2.2, and the claim is committed before any provider call.
It is the durable-claim shape ADR-050 uses for the outbox.

**Per row, tenant-scoped.** Each claimed row runs under
`runWithContext({ organizationId: row.organization_id, userId: SERVICE_NAME, … })`, as the consumers
do (`settlement-authority.consumer.ts:136`). Every query after the claim goes through the tenant
guard, and `lockIntent` already names the organization explicitly (`:345-360`).

**Ask the provider** (`getStatus`, with a timeout), outside any transaction.

**Apply** through the **same code paths** as the request flow. Each is a compare-and-set under the
intent's row lock, and each re-reads the status after locking:

| Intent (locked, re-read)                    | Provider says                           | Action (existing path)                                                                                                                                            |
| ------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CREATED`                                   | `NOT_FOUND` (authoritative) or `FAILED` | `fail()`, which releases the reservation                                                                                                                          |
| `CREATED`                                   | `AUTHORIZED`                            | record `AUTHORIZED` + ref (tx 2 code), then as the next row; **Q-B**                                                                                              |
| `AUTHORIZED`                                | `AUTHORIZED`                            | `provider.capture` with the **same idempotency key**, then as the next row; **Q-B**                                                                               |
| `AUTHORIZED` (± marker)                     | `CAPTURED`, refund `NONE`               | `recordCaptureOrFindIt` → `completeCapture`; uncreditable → `returnUncreditedCapture`, whose refund outcome is then read back by the next pass instead of assumed |
| `AUTHORIZED`                                | `CAPTURED`, refund `REFUNDED`           | `fail(CAPTURE_NOT_CREDITED)`: no ledger movement (U6, U8)                                                                                                         |
| `AUTHORIZED`                                | `FAILED`                                | `fail()` with the provider code (U4)                                                                                                                              |
| `REFUND_PENDING`                            | refund `REFUNDED`                       | tx B: release hold, `ledger.reverse`, `REFUNDED` (R1)                                                                                                             |
| `REFUND_PENDING`                            | refund `FAILED`                         | release hold, back to `CAPTURED`, `PAYMENT_REFUND_FAILED`                                                                                                         |
| `REFUND_PENDING`                            | refund `NONE`/`PENDING`                 | re-issue `provider.refund` with the same key `…:refund` (provider-side dedupe)                                                                                    |
| any                                         | `UNKNOWN` / throw / timeout             | backoff (below)                                                                                                                                                   |
| row no longer matches (terminal, or `NONE`) | —                                       | skip; someone else resolved it                                                                                                                                    |

No ledger row is ever edited. Credit and refund use `wallets.credit` and `ledger.reverse`, the same
double-entry journals and the same DB triggers (`trg_journal_balanced`, the immutability triggers).
A failed capture posts nothing, as today.

**No double credit, by three independent locks:**

1. `SKIP LOCKED` together with the lease: two reconcilers never claim the same row at the same time.
2. The row-lock CAS in `completeCapture` (`:569-572`): only an `AUTHORIZED` intent is captured.
3. `ux_transaction_source_fact (organization_id, source_type, source_reference)`: the database
   refuses a second `WALLET_TOP_UP` transaction for the same intent, even if (1) and (2) were both
   bypassed.

(2) and (3) also cover a lease that expires mid-call: two workers may then both ask the provider,
but only one can apply.

**Late client retry.** `resume` stops refusing with "being reconciled" and calls the same
`reconcileOne(intent)` synchronously: same claim, same CAS, same table. A retry and a reconciler
racing each other both go through (2) and (3), and the loser's CAS finds a terminal row and answers
from it (`capturedView` / `FAILED`). **U6 is fixed here too:** a `CAPTURED_NOT_CREDITED` intent is
only credited after `getStatus` says the provider still holds the capture.

**Backoff and the terminal state.** Each unresolved attempt sets
`next_reconcile_at = now + min(base · 2^attempts, max) + jitter` (the jitter is deterministic from
the id, so tests are stable). After `maxAttempts` **or** `maxAge`, the row becomes
`reconcile_state = 'ESCALATED'` with `escalated_at` set, in one transaction with a new
**`PAYMENT_RECONCILIATION_ESCALATED`** event. That event carries the status seen, the last provider
answer (a code) and the attempt count; it carries no amounts beyond the existing payload shape and
no instrument (S-09).

audit-service already ingests every `rasta.economic.v1` event generically
(`audit.mapper.ts:229,272`), so that event is the audit record. The row's reservation stays held,
which is fail-safe: the balance cannot be inflated.

**Human resolution** (a separate PR): `POST /v1/payment-intents/:id/reconciliation`. It requires an
idempotency key and a reason, and `assertNotAuditor`. Actions:

- `requeue` — back to `SCHEDULED`, attempts reset;
- `resolve` with `outcome ∈ {FAILED, CAPTURED, REFUNDED}` and an `evidenceReference` — applied
  **through the same table/paths** as a provider answer, with the actor and reason on a new
  `PAYMENT_RECONCILIATION_RESOLVED` event.

Roles and four-eyes are **Q-C**.

New events (`PAYMENT_REFUNDED`, `PAYMENT_REFUND_FAILED`, `PAYMENT_RECONCILIATION_ESCALATED`,
`PAYMENT_RECONCILIATION_RESOLVED`) go into `src/events/events.ts`, `NEVER_AUTO_REPLAY`, docs/07, and
the Kafka event-contract docs, keyed by `aggregateId = intentId` (ADR-036).

### 2.5 Where it runs: an in-process timer, not Temporal

- economic-service runs **no Temporal worker**. Only marketplace does
  (`services/marketplace-service/src/temporal/worker.ts`). ADR-031 and PROJECT_MEMORY § 7-C keep
  settlement out of Temporal, and `LedgerBalanceAudit` (`src/wallet/balance-audit.ts:20-27,67-79`)
  is the existing precedent: a docs/10 Temporal workflow replaced by an in-process timer, with the
  substitution recorded.
- All reconciler state lives in `payment_intent`, not in the process. A crash loses one claim, which
  the lease returns. Temporal's durability would duplicate what the row already provides, and would
  add a worker, a task queue, deployment and an ADR to economic-service.
- It differs from the balance audit in one way: it **writes**. So it is not "safe because read-only";
  it is safe on every replica because of § 2.4 (1)–(3). There is no leader election.
- The seam is `reconcileOne(intentId)`, so a later Temporal activity would wrap the same function.

### 2.6 Configuration (`src/config/env.ts`, zod, beside `ECONOMIC_BALANCE_AUDIT_*`)

`ECONOMIC_PAYMENT_RECONCILER_ENABLED` · `_INTERVAL_SECONDS` · `_BATCH_SIZE` · `_GRACE_SECONDS` ·
`_LEASE_SECONDS` · `_BACKOFF_BASE_SECONDS` · `_BACKOFF_MAX_SECONDS` · `_MAX_ATTEMPTS` ·
`_MAX_AGE_HOURS` · `ECONOMIC_PAYMENT_PROVIDER_TIMEOUT_MS`

Each has bounds and a default. `.env.example` is updated. The integration test harness sets
`ENABLED=false` and drives `runOnce()` directly, so tests control time and order.

### 2.7 Metrics and alerts

Metrics (in `src/observability/metrics.ts`; no intent or wallet ids in labels, S-09):

- `rasta_payment_reconcile_attempts_total{outcome}`;
- `rasta_payment_reconcile_scheduled` (gauge);
- `rasta_payment_reconcile_escalated` (gauge);
- `rasta_payment_reconcile_oldest_age_seconds` (gauge);
- `rasta_payment_provider_status_total{result}`;
- `rasta_payment_reconcile_pass_duration_seconds`;
- `rasta_payment_reconcile_last_pass_timestamp_seconds`.

Alerts, in a new `infrastructure/docker/prometheus/rules/rasta-economic-payment-alerts.yml` with a
promtool test beside the existing audit and notification ones:

| Alert                               | Condition                                       | Severity |
| ----------------------------------- | ----------------------------------------------- | -------- |
| `PaymentReconciliationEscalated`    | `escalated > 0`                                 | critical |
| `PaymentReconciliationBacklogAging` | oldest age > threshold                          | warning  |
| `PaymentReconcilerStalled`          | last pass older than 5 × interval while enabled | warning  |

## 3. Tests

**Unit:**

- the decision table in § 2.4 as a pure function, with every row and every unknown combination;
- the backoff and escalation arithmetic;
- the mock's `getStatus`, its lost-response directives and closed-set refusals;
- env bounds.

**Integration** (`--runInBand`, real PostgreSQL). One test per unknown outcome, each driven by mock
directives or by an injected fault in the write path. Every test ends with `runOnce()` and asserts:

- the final status;
- exactly one `WALLET_TOP_UP` journal, or none;
- the wallet balance equals the ledger (reusing `LedgerBalanceAudit.run()` → 0 deviations);
- the reservation is released;
- the event is in the outbox.

The cases are U1–U8, R1, R2, the `UNKNOWN` → backoff → `ESCALATED` path with its event, and a
human `requeue` / `resolve`.

**Concurrency:**

- two `PaymentReconciler` instances on the same due set, run concurrently: every intent is
  credited once;
- a reconciler and a same-key client retry racing on one `U3`/`U5` intent: one credit, and both
  answers agree;
- a reconciler and an operator refund on one intent;
- an expired lease with two workers applying.

**Tenant isolation** (`tenant-isolation.int-spec.ts` style):

- tenant A's due intents are applied under A's context only, and B's rows and wallets are
  untouched;
- a claimed row whose context would mismatch is refused;
- the reconciliation endpoint answers 404 across tenants;
- events carry the row's organization.

**Migration:**

- `verify-migration-reversible.mjs economic` (up → down → up), including `down.sql` refusing when
  `REFUND_PENDING` rows exist;
- `test:tenant-index-order`.

Per package, before each push: lint, typecheck, unit, integration (`--runInBand`), prettier
`--check`, and the migration verifier.

## 4. PR split

| PR                 | Content                                                                                                                                                                                                                                                                                          | Size |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| **A** (this draft) | this plan; then the ADR text (ADR-024 amendment or a new ADR, number from PM)                                                                                                                                                                                                                    | docs |
| **B**              | failing tests for U1–U8, R1 and R2 first, then: port and mock extension, provider timeout, migration (states, columns, partial index, `down.sql`), marker written from birth, `resume` asking `getStatus` (U6), two-phase refund with hold (R2) and `PAYMENT_REFUNDED` / `PAYMENT_REFUND_FAILED` | M–L  |
| **C**              | `PaymentReconciler` (claim, apply, backoff, escalate), config, metrics, alert rules and promtool test, concurrency and tenant tests                                                                                                                                                              | M    |
| **D**              | human resolution endpoint and OpenAPI, `PAYMENT_RECONCILIATION_RESOLVED`, runbook, PROJECT_MEMORY and docs/23 D-035 update                                                                                                                                                                       | S–M  |

B can land alone; it already removes the two money-losing paths (U6, R2). C depends on B, and D on C.
If you prefer, R2 alone (move `assertSufficient` before the provider call) can go first as a
one-file fix.

## 5. Risks

- **Mock after restart answers `UNKNOWN`.** In the demo stack, every stuck intent ends
  `ESCALATED`. That is the honest answer, not a bug, but it means escalation is the normal path for
  the mock across restarts.
- **Enum `down.sql`.** Recreating the type locks `payment_intent` briefly. It is fine at MVP volume;
  I will note it in the migration.
- **Behaviour change for clients.** A same-key retry of a stuck intent now resolves instead of
  returning 422. Some U cases may now answer `FAILED` where a retry used to be refused.
- **The hold in the refund** adds a `FUNDS_HELD` / `FUNDS_RELEASED` pair to every refund's ledger
  history (visible and balanced, but new).
- **The reconciler capturing an authorization on its own** (Q-B) is money movement without a live
  request. It uses the same idempotency key, but it is a product decision.
- `packages/nest-common` is **not** touched: `runWithContext`, `runUnscoped` and the outbox are
  used as they are, and the claim SQL lives in economic-service. supplier-service is not touched.

## 6. Questions for the PM

The docs/24 Q-numbers and the ADR number are needed from you. I will not write into docs/24 or
docs/26.

- **Q-A.** Should the operator refund hold the funds (a `WalletHold`) between the check and the
  provider call? I recommend yes.
- **Q-B.** When the provider says `AUTHORIZED` for a stuck intent, should the reconciler **capture**
  (same key; the user's request was complete) or leave it and escalate? The port has no `void`. I
  recommend capture, behind a config flag that defaults to escalate until the product owner
  answers.
- **Q-C.** Who may resolve an escalated intent by hand (`SYSTEM_ADMIN` only? four-eyes?), and must
  `resolve` carry external evidence? This is governance, so it should be configurable, not
  hard-coded (A-principle 9).
- **ADR:** amend ADR-024 (the port's `getStatus` shape changes) or write a new ADR ("payment
  reconciliation")? Which number?
- **Index:** a cross-tenant partial index with an `EXEMPTIONS.economic` entry, or a per-tenant
  scan?
