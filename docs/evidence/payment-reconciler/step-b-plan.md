# Durable payment reconciler, step B — STEP 0 plan

> Branch `fix/economic-payment-reconciler-b`, cut from `fix/economic-refund-safety` @ `3a0a5d0` (#143, B0, queued). I will
> merge `main` in once #143 lands and never rebase. ADR-064; D-035; Q-81; Q-82. **B1 (the task table) is implemented on this
> branch; B2 and B3 are not.** Only `MockPaymentProvider` exists; no bank connection is claimed (ADR-024).

## 0. Rulings (PM, on this plan)

GO, with these answers. Where they differ from the plan below, they win.

- **Q-B1 — agreed.** The stuck top-up intents (U1–U5, U7, U8) are step C.
- **Q-B2 — agreed.** The markers stay in `failure_reason`. ADR-064 § 8 is amended in place (on #140).
- **Q-B3 — build four-eyes in B.**
  - `resolve` creates a `PENDING_APPROVAL` resolution.
  - A second `SYSTEM_ADMIN` approves or rejects it. That person is neither the proposer nor the intent's creator.
  - Only an approval runs the apply function.
  - Both actors and the evidence go on the event and in the audit record.
  - `ECONOMIC_PAYMENT_RECONCILIATION_RESOLUTION_FOUR_EYES` defaults to `true`. The config refuses `false` unless `NODE_ENV`
    is `development` or `test`.
  - `requeue` stays single-actor.
- **Split into three PRs, not two:**
  - **B1:** the table, the wiring and its tests.
  - **B2:** the sweeper and the provider query.
  - **B3:** the operator path with four-eyes.

  Each PR ships with:
  - its failing tests first;
  - economic unit and integration tests;
  - coverage at or above the thresholds;
  - the E2E critical path;
  - the migration verifier.

**What B1 changed from § 2.1** (on this branch):

- `evidence_reference` is not in B1's table. B3 adds what four-eyes needs.
- `ESCALATED` implies `escalated_at` rather than the other way round, so a task resolved after escalation keeps the time as
  history.
- The foreign key is composite, `(organization_id, payment_intent_id)`, as in #148.
- Backfilled rows are `PRT_<intent id>`.

`file:line` references are to `services/economic-service/src/payment/payment.service.ts` at `3a0a5d0` unless another
file is named.

## 1. What B0 leaves, and what step B must close

B0 (#143) makes every operator refund fail safe:

- **Hold, then ask the provider.** `refund` `:794` holds the amount (`:806`) before `provider.refund` (`:864`).
- **Outcome not recorded.** The hold stays and one of four markers is left on the `CAPTURED` intent's `failure_reason`
  (`:1177-1201`).
- **Top-up side.** The same pattern exists as `CAPTURED_REFUND_UNKNOWN` (`:1169`, from `returnUncreditedCapture` `:501`).

| Marker                                   | Provider outcome                     | Today                                                                       |
| ---------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| `REFUNDED_NOT_REVERSED`                  | refunded (known)                     | a manual refund call runs step 3 again (`:830`); nothing does it on its own |
| `REFUND_DECLINED_RELEASE_PENDING`        | declined (known)                     | a manual refund call returns the hold (`:812`); nothing does it on its own  |
| `REFUND_UNKNOWN`                         | unknown                              | **refused forever** (`:838`)                                                |
| `REFUND_REQUESTED` (aged)                | unknown (crash; or a double failure) | **refused forever** (`:838`)                                                |
| `CAPTURED_REFUND_UNKNOWN` (`AUTHORIZED`) | unknown                              | refused on retry (`resume` `:404`); no path out                             |

The residual accepted on #143 (docs/23 D-035, ADR-064 §2) has three parts:

- nothing scans these intents;
- nothing asks the provider about them;
- the only way out of the unknown ones is a manual `UPDATE` in `docs/runbooks/payment-refund-stuck.md` §4-2.

Step B closes all three.

## 2. Design

### 2.1 A task table, as in #148's sweeper

`payment_reconciliation_task` is its own table, following the construction reconciliation queue in #148
(`policy_reconciliation_task`, `PolicyReconciliationSweeper`). It is not columns on `payment_intent`.

Scheduling state (lease, attempts, backoff, escalation) is not the payment's state. Keeping it apart leaves the intent row
and its lifecycle CHECK unchanged. The markers stay where B0 put them, in `failure_reason`, because they describe the
money.

```
payment_reconciliation_task
  id                 TEXT PK            -- PRT_<ULID>
  organization_id    TEXT NOT NULL      -- the intent's tenant; every per-row query filters on it
  payment_intent_id  TEXT NOT NULL      -- FK payment_intent(id)
  kind               enum REFUND | UNCREDITED_REFUND
  status             enum PENDING | ESCALATED | DONE
  attempts           INT NOT NULL DEFAULT 0
  next_attempt_at    TIMESTAMP(3) NOT NULL
  lease_until        TIMESTAMP(3) NULL
  lease_token        TEXT NULL          -- the fence
  last_outcome       TEXT NULL          -- a closed code (S-09)
  correlation_id     TEXT NOT NULL
  escalated_at       TIMESTAMP(3) NULL
  resolved_by        TEXT NULL          -- RECONCILER | <user id>
  resolution         TEXT NULL          -- closed code
  evidence_reference TEXT NULL          -- operator resolutions only; pattern-checked, no free text
  created_at, updated_at, done_at
```

- `ux_payment_reconciliation_open` — unique on `(payment_intent_id)` `WHERE status <> 'DONE'`. At most one open task per
  intent; this is what makes enqueueing idempotent.
- `ix_payment_reconciliation_due` — on `(next_attempt_at)` `WHERE status = 'PENDING'`. A single-column partial index, like
  #148's; the tenant-index-order check does not flag single-column indexes, so no exemption is needed.
- CHECKs, as in #148:
  - lease pair: `num_nonnulls(lease_until, lease_token) IN (0,2)`;
  - `DONE` ⇔ `done_at`;
  - `ESCALATED` ⇔ `escalated_at`;
  - attempts ≥ 0;
  - `evidence_reference` only when `resolved_by` is a user.
- **Migration:** reversible, with `down.sql`. It **backfills** one PENDING task, due now, for every intent that already
  carries one of the five markers. `down.sql` refuses (with a hint) while open tasks exist; this follows the refuse-on-data
  pattern of `20260924120000`. It is checked with `verify-migration-reversible.mjs economic`.

### 2.2 The task is born with the risk

The task is written **in the same transaction** as the thing that can strand money, so a crash never leaves a marker
without its task:

| Where (B0)                                                         | Task written        | Due                                                |
| ------------------------------------------------------------------ | ------------------- | -------------------------------------------------- |
| refund step 1, `REFUND_REQUESTED` + hold (`:806`)                  | `REFUND`            | `now + GRACE`                                      |
| `markRefundUnresolved` (`:1070`), any marker                       | reuse the open task | now (a known outcome) or `now + backoff` (unknown) |
| `returnUncreditedCapture` marks `CAPTURED_REFUND_UNKNOWN` (`:501`) | `UNCREDITED_REFUND` | `now + GRACE`                                      |

Every terminal write marks the task `DONE` **in the same transaction**. The terminal writes are:

- step 3 `REFUNDED` (`:904`);
- the declined release (`returnDeclinedHold` `:1038`).

**Correction (Codex on #161):** an earlier draft also listed the request path's `CAPTURED_NOT_CREDITED`/`FAILED` writes
(`completeCapture`, `fail`). Those do not close a task, and need not: no request path reaches an intent with an open
`UNCREDITED_REFUND` task (`resume` refuses `CAPTURED_REFUND_UNKNOWN`). That task is closed by the reconciler (B2), in the
apply transaction that fails the intent or marks it `CAPTURED_NOT_CREDITED`, and by the operator path (B3).

So the request path and the sweeper agree on whether work is left, **as long as every writer runs this code**. A B0
instance still running during the deploy does not; B2's sweeper therefore also heals both directions each cycle (a marker
with no open task, an open task whose marker is gone), so correctness does not depend on deploy order (Codex on #161, HIGH
1).

- **Why a grace period:** it keeps the sweeper away from a refund whose provider call is still in flight.
- **The config refuses** `GRACE <= 2 × ECONOMIC_PAYMENT_PROVIDER_TIMEOUT_MS`.
- **Provider call timeout:** step B adds this new timeout around every provider call (none exists today). A hanging
  provider becomes an unknown outcome, which the sweeper then resolves, instead of a hung request.

### 2.3 The sweeper (`PaymentReconciliationSweeper`, in-process)

It has the same shape as #148:

- `setInterval`;
- never overlaps itself;
- `stop()` awaits the running sweep on shutdown;
- `runOnce()` is public, for tests and for the operator tool.

It runs in-process, not in Temporal: economic has no worker (ADR-031, ADR-064 §7), and all state lives in the row.

**Claim.** One short transaction; this is the only unscoped query (`runUnscoped` with a written reason).

```sql
UPDATE payment_reconciliation_task
   SET lease_until = now() + ($2 * interval '1 second'), lease_token = $3, updated_at = now()
 WHERE id IN (SELECT id FROM payment_reconciliation_task
               WHERE status = 'PENDING' AND next_attempt_at <= now()
                 AND (lease_until IS NULL OR lease_until <= now())
               ORDER BY next_attempt_at LIMIT $1
               FOR UPDATE SKIP LOCKED)
RETURNING id, organization_id, payment_intent_id, kind, attempts, lease_token, correlation_id;
```

**Per task, in the task's tenant.** Each task runs under
`runWithContext(createSystemContext({ organizationId: task.organization_id, correlationId }))`. After the claim, every
query goes through the tenant guard, and `lockIntent` (`:346`) already names the organization.

1. **Read the intent.** No lock is taken yet, and no provider call has happened. If the intent carries no marker any more,
   or is terminal, the task goes `DONE` as a no-op (fenced).
2. **Ask the provider**, outside any transaction, under the call timeout. It is asked only for the unknown markers
   (`REFUND_REQUESTED`, `REFUND_UNKNOWN`, `CAPTURED_REFUND_UNKNOWN`). The two known markers need no question.
3. **Apply** in one transaction:
   - take the intent lock, then the wallet lock (`lockForRefund` `:984`, the same order everywhere);
   - re-read the marker under the lock;
   - run the same B0 code the request path runs, extracted and not duplicated (see the table below);
   - **fence** by updating the task to `DONE` `WHERE lease_token = $token AND status = 'PENDING'`. If that touches 0 rows,
     throw, and the whole effect rolls back. A sweeper whose lease was taken back can neither move money nor emit.

| Marker (under lock)                                           | Provider refund status                                               | Effect (existing code)                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `REFUNDED_NOT_REVERSED`                                       | — (known)                                                            | `recordRefunded` = step 3 (`:904`): `refundHold` → defence `assertSufficient` → `ledger.reverse` → `REFUNDED` |
| `REFUND_DECLINED_RELEASE_PENDING`                             | — (known)                                                            | `returnDeclinedHold` (`:1038`)                                                                                |
| `REFUND_REQUESTED` / `REFUND_UNKNOWN`                         | `REFUNDED`                                                           | `recordRefunded`                                                                                              |
| `REFUND_REQUESTED` / `REFUND_UNKNOWN`                         | `DECLINED`                                                           | `returnDeclinedHold`                                                                                          |
| `REFUND_REQUESTED` / `REFUND_UNKNOWN`                         | `NOT_FOUND`, **authoritative** (the call never reached the provider) | `returnDeclinedHold`                                                                                          |
| `CAPTURED_REFUND_UNKNOWN`                                     | `REFUNDED`                                                           | `fail(CAPTURE_NOT_CREDITED)` (`fail` `:695`): `FAILED`, no ledger movement                                    |
| `CAPTURED_REFUND_UNKNOWN`                                     | `DECLINED` / authoritative `NOT_FOUND`                               | marker → `CAPTURED_NOT_CREDITED` (a same-key retry credits it, as in B0)                                      |
| any unknown marker                                            | `UNKNOWN` / throw / timeout / non-authoritative `NOT_FOUND`          | **nothing moves**; attempts + 1; backoff; escalate at the limit                                               |
| any, with wallet `FROZEN` and the effect would take money out | —                                                                    | deferred: released without an attempt, due again after the backoff; escalate at `maxAge`                      |

No posted ledger entry is ever edited. Money moves only through `refundHold` and `ledger.reverse`, the same double-entry
journals under the same triggers. `Wallet ≠ Ledger` holds, because balances are recomputed from the ledger
(`recomputeFromLedger`).

**Backoff and escalation.**

- Each unresolved attempt is rescheduled at `min(BACKOFF · 2^attempts, BACKOFF_MAX)`.
- At `MAX_ATTEMPTS`, or `MAX_AGE` since `created_at`, the task becomes `ESCALATED`, with `escalated_at` set, in the same
  transaction as a new **`PAYMENT_RECONCILIATION_ESCALATED`** event. The event carries the intent, the marker, the last
  outcome code and the attempts. It carries no amounts beyond the existing payload shape and no instrument.
- The hold stays in place (fail safe).
- `audit-service` ingests every `rasta.economic.v1` event, so the event is the audit record.

### 2.4 Provider port: an ADR-064 §3 amendment, scoped to refunds

`getStatus(providerReference)` (`provider.ts:106`) answers about the _payment_. Step B needs the status of **one refund
attempt**, and the port gains:

```ts
getRefundStatus(query: {
  paymentIntentId: string; providerReference: string; idempotencyKey: string;   // `${key}:refund` or `${key}:uncredited`
}): Promise<{ refund: 'REFUNDED' | 'DECLINED' | 'NOT_FOUND' | 'UNKNOWN'; authoritative: boolean;
              failureCode?: string /* through failureCodeFrom, S-09 */; simulated: boolean }>;
```

`NOT_FOUND` means the provider never received the attempt. It is acted on **only** when `authoritative` is true;
otherwise it is treated as `UNKNOWN`. **Never assume.**

**`MockPaymentProvider`.** It already remembers every refund by `(reference, key)` (B0). It answers `REFUNDED` or
`DECLINED` from that memory. For an attempt it has never seen:

- If the intent's refund was requested _after_ this mock instance started, it answers `NOT_FOUND` with `authoritative:
true`. It would have seen the attempt.
- Otherwise it answers `UNKNOWN` with `authoritative: false`, because a restart wiped its memory.

To judge this the mock needs the time the refund was requested. The query therefore also carries
`requestedAt: Date`, taken from the hold's `placed_at`; a real adapter would ignore it. There is a lost-response
directive (`lose-refund`) and a `hang-refund` directive for the timeout, using the same closed-set parsing as today.

The existing `getStatus` is kept, unchanged. The top-up side (§6) will use it later.

### 2.5 The operator path, replacing the runbook's manual `UPDATE` (Q-82)

The endpoint is `POST /v1/payment-intents/{id}/reconciliation`.

- **Access:** tenant-scoped (a cross-tenant id answers 404, as `refund` does).
- **Idempotency:** requires an `Idempotency-Key`.
- **Auditors:** `assertNotAuditor`.

Authorisation follows Q-82's provisional answers:

- **Roles:** from `ECONOMIC_PAYMENT_RECONCILIATION_RESOLVER_ROLES`, default `SYSTEM_ADMIN` only.
- **Creator excluded:** the resolver may not be the intent's `created_by`.
- **Four-eyes:** built in B3, on by default. See § 0 (Q-B3) and ADR-064 § 6.

Body:

- `{ action: 'requeue', reason }`
  - Moves an `ESCALATED` task back to `PENDING`, due now, with attempts reset.
  - No evidence is needed.
- `{ action: 'resolve', providerOutcome: 'REFUNDED' | 'DECLINED' | 'NOT_REACHED', evidenceReference, reason }`
  - `evidenceReference` is **mandatory**, pattern-checked, and never free text on the event.
  - The operator's statement of the provider's answer goes through **the same apply function as a provider answer** (the
    §2.3 table): same locks, same fence.
  - The endpoint takes the task's lease with its own token in the transaction.
  - The task records `resolved_by = <userId>`, `resolution` and `evidence_reference`, and a new
    **`PAYMENT_RECONCILIATION_RESOLVED`** event carries the actor, the outcome and the evidence reference.
  - The sweeper uses the same event with `resolvedBy: 'RECONCILER'`.

The endpoint refuses `resolve` when:

- the marker is a known one — the sweeper or `requeue` handles those;
- the stated outcome contradicts a provider answer already on record;
- the wallet is `FROZEN` and the outcome would take money out.

When this lands, `payment-refund-stuck.md` §4-2 (the manual `UPDATE` of the marker) is **deleted**. The runbook then
points at this endpoint and the escalation alert.

### 2.6 Configuration, metrics, alerts

**Config** (`env.ts`, zod, bounded, with defaults; listed in `.env.example`):

- `ECONOMIC_PAYMENT_RECONCILER_ENABLED`
- `_INTERVAL_MS`, `_BATCH_SIZE`, `_LEASE_SECONDS`, `_GRACE_SECONDS`
- `_BACKOFF_SECONDS`, `_BACKOFF_MAX_SECONDS`, `_MAX_ATTEMPTS`, `_MAX_AGE_HOURS`
- `ECONOMIC_PAYMENT_PROVIDER_TIMEOUT_MS`
- `ECONOMIC_PAYMENT_RECONCILIATION_RESOLVER_ROLES`, `_FOUR_EYES`

Cross-checks: the grace period must exceed twice the provider timeout, and the lease must exceed the timeout plus one
transaction.

**Metrics** (no intent or wallet ids in labels):

- `rasta_economic_payment_reconciliation_total{result}` — resolved_refunded, resolved_declined, deferred_frozen, retried,
  escalated, lost_lease, noop
- gauges `…_open`, `…_escalated`, `…_oldest_due_age_seconds`, `…_last_sweep_timestamp_seconds`
- `rasta_economic_payment_provider_status_total{result}`

**Alerts** go in a new `infrastructure/docker/prometheus/rules/rasta-economic-alerts.yml`, with a promtool test, as for
audit and notification:

| Alert                                    | Condition                                               | Severity |
| ---------------------------------------- | ------------------------------------------------------- | -------- |
| `RastaPaymentReconciliationEscalated`    | `…_escalated > 0`                                       | critical |
| `RastaPaymentReconciliationBacklogAging` | oldest due age above a threshold for 15m                | warning  |
| `RastaPaymentReconcilerStalled`          | the last sweep is older than 5 × interval while enabled | warning  |

The runbook gains the alerts' "signal" section.

## 3. Tests

- **Unit:**
  - the apply table as a pure decision function, covering every marker × answer × wallet status;
  - the backoff and escalation arithmetic;
  - the env cross-checks;
  - the mock's `getRefundStatus`, including the boot-time rule and its directives.
- **Integration** (`--runInBand`, real PostgreSQL), one per row of the §2.3 table. Each ends with an assertion on:
  - the intent's status and marker;
  - the hold's status;
  - the journals (exactly one reversal, or none);
  - `LedgerBalanceAudit.run()` reporting 0 deviations;
  - the task's status;
  - the event in the outbox.
- **Birth and death:**
  - A crash (a thrown error) right after step 1 leaves an intent with the marker and a due task.
  - Every terminal path marks the task `DONE`.
  - The migration backfill enqueues existing markers.
- **Concurrency** (barrier-controlled, as in B0):
  - Two sweepers run on the same due set; each intent is resolved once.
  - A lease expires mid-provider-call and another sweeper takes the task: only one applies, and the stale one's fence
    rolls back its effect.
  - The sweeper races a late step 3 of the original request, and the operator endpoint races the sweeper; in each case
    only one resolution is recorded.
- **Escalation:** `UNKNOWN` repeats until `ESCALATED`, with the event, the metric and the hold intact; then `requeue`,
  then `resolve`.
- **Operator path:**
  - role refused;
  - creator refused;
  - missing evidence refused;
  - contradiction refused;
  - known marker refused;
  - cross-tenant id answers 404;
  - resolution is idempotent under a replayed key.
- **Tenant isolation:** a task of tenant A runs only in A's context and touches nothing of B.
- **Migration:** the verifier runs up → down → up, and `down` refuses while tasks are open.
- **Alerts:** a promtool test for the three rules.
- **Per package, before each push:** lint, typecheck, unit, integration, `test:coverage` (the 90% gate), prettier and the
  migration verifier.

## 4. PR split

| PR     | Content                                                                                                                                                                                                                | Size |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| **B1** | migration and task table; enqueue at birth and `DONE` at death; provider timeout; `getRefundStatus` on the port and the mock; the sweeper with the full §2.3 table, backoff, escalation, event, metrics, alerts; tests | L    |
| **B2** | the operator endpoint (Q-82), OpenAPI, `PAYMENT_RECONCILIATION_RESOLVED` from operators, runbook §4-2 replaced, docs/07, docs/events, ADR-064 amendments, PROJECT_MEMORY, docs/23 D-035 closed                         | M    |

B1 alone already removes the "refused forever" state, because every unknown outcome is asked, resolved or escalated. B2
gives the human the tool.

## 5. Risks

- **The mock after a restart** answers `UNKNOWN` for every attempt made before the restart. In the demo stack those
  intents escalate, which is the honest outcome; the operator path handles them.
- **The sweeper and a live request.** The grace period and the timeout cross-check keep them apart. If they still meet,
  the fence and the intent lock let exactly one apply. The late request's step 3 then finds the intent `REFUNDED` and
  answers `409`, even though the refund did happen. B1 changes that step 3 to answer with the refunded view when it finds
  the work already done.
- **Four-eyes** is a second actor and a pending state. If you want it in B2 rather than as a documented switch that is off,
  it grows B2 noticeably.
- **The top-up side** (U1–U5, U7, U8: stuck `CREATED`/`AUTHORIZED` intents) is **not** in B. See §6.

## 6. Questions for the PM

- **Q-B1 — scope.** B covers the four refund markers and `CAPTURED_REFUND_UNKNOWN` (the provider-refund-unknown family).
  The stuck _top-up_ intents (`CREATED`/`AUTHORIZED` with no marker; STEP 0 U1–U5, U7, U8) need `getStatus` on the payment
  and a capture policy (Q-81). I propose them as **step C**, on the same task table and sweeper. Agree?
- **Q-B2 — markers stay in `failure_reason`.** ADR-064 §8 planned a `REFUND_PENDING` status plus columns on
  `payment_intent`. With #148's separate task table, the markers can stay where B0 put them and no enum migration is
  needed. I propose amending ADR-064 §8 accordingly. Agree?
- **Q-B3 — four-eyes.** Build it in B2, or leave it as a documented config switch, defaulting off, that refuses to start
  when set to `true` until it is built? I recommend the latter.
- **Numbers:** I need none now. ADR-064 is amended in place. Tell me if you want the escalation alert under a D-number, or
  a new Q for Q-B1.
