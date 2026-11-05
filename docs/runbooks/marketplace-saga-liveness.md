# Runbook: marketplace saga liveness and unresolved financial steps (FU-104, #770 r2 F3)

**Severity:** 🔴 critical — money is held, or its outcome is unconfirmed, and nothing is moving it.
**Alerts:** `RastaMarketplaceSagaWorkerDown`, `RastaMarketplaceSagaNoLiveWorker`,
`RastaMarketplaceSagaFinancialStepUnresolved` (`infrastructure/docker/prometheus/rules/rasta-marketplace-alerts.yml`).
**Scope:** the order saga worker (`orderSaga` on `MARKETPLACE_TEMPORAL_TASK_QUEUE`, default `rasta-order`) inside every
marketplace-service replica, and the orders it owes a financial step.

---

## Why these alerts are built on state

A worker that failed used to write one log line and nothing else; an alert built on a retry counter cleared as soon as
the retries stopped, whether or not anything was resolved. Both now come from state:

| Series                                                  | Meaning                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rasta_marketplace_saga_worker_up`                      | Per replica. `1` only while the SDK reports the worker `RUNNING` **and** Temporal lists this worker's own identity (`marketplace-saga@<host>/<pid>/<uuid>`) as a poller of both the workflow and the activity task queue. Disabled, never started, ended, stopping, or a probe that failed: `0`. |
| `rasta_marketplace_saga_unresolved_orders{reason}`      | Orders waiting on a financial step the saga owes, read from the database every 10 s by every replica, whether or not it runs a worker.                                                                                                                                                           |
| `rasta_marketplace_saga_unresolved_age_seconds{reason}` | How long the oldest of them has waited (database clock); `0` when none.                                                                                                                                                                                                                          |

`reason` is one of:

| `reason`            | The order is …                                                                                                            | The saga owes …                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `PENDING`           | placed; the hold is not confirmed                                                                                         | the hold (`createObligation`), or `FAILED` |
| `RECEIPT_CONFIRMED` | confirmed by the buyer, or back after a failed settlement attempt                                                         | authorisation and settlement               |
| `SETTLING`          | in a settlement attempt                                                                                                   | the settlement's outcome                   |
| `CANCELLING`        | cancelled, or refunded by a dispute decision                                                                              | the refund (`compensate`)                  |
| `DISPUTE_RELEASE`   | back in a party wait after an operator's SETTLE (D-083), its dispute mirrored to economic-service and no release recorded | the release (`resolveObligationDispute`)   |

The age counts from when the order last left a party's hands, so a settlement bouncing `RECEIPT_CONFIRMED ↔ SETTLING`
does not reset it; for `DISPUTE_RELEASE`, from when it left `DISPUTED`. A sample that fails, and a replica that is
stopping, **withdraw** the series instead of leaving the last value; every alert reads a missing series as unknown and
fires.

## What fires, and how fast

| Alert                                         | Fires when                                                                                                       | At the latest                                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RastaMarketplaceSagaWorkerDown`              | a replica reports `worker_up == 0` for 2 min                                                                     | `run()` failed or ended: 2 min + one scrape. Still `RUNNING` but no longer polling: Temporal drops a poller about 5 min after its last poll (5 min 9 s on the dev server), probed every 15 s, then 2 min — about 7.5 min. |
| `RastaMarketplaceSagaNoLiveWorker`            | no replica reports `worker_up == 1` — all `0`, or no series at all (every replica down or unscraped) — for 2 min | as above; a replica that is gone stops reporting at its next scrape                                                                                                                                                       |
| `RastaMarketplaceSagaFinancialStepUnresolved` | the oldest owed step is over 1 h old, **or** no replica reports the gauge, for 5 min                             | 1 h 5 min after the order entered the saga's custody                                                                                                                                                                      |

`FinancialStepUnresolved` does **not** clear when the retries stop, when the saga workflow ends, or when every worker or
the whole service dies: it clears only when the order moves on (or the gauge is reported again and shows nothing over
1 h). The `max(...)` and `absent(...)` arms carry the same empty label set, so a reporter dying keeps the alert firing
instead of resolving it and opening a new one.

## What the operator does

Never `terminate` or `reset` a saga, and never change an order's status by hand, to clear an alert: the funds stay
held with no compensating path ([`docs/24`](../24-open-questions.md) Q-118). Silence these alerts only for a gated
deployment window (below), with the change record's id and an expiry at the window's end.

### `RastaMarketplaceSagaWorkerDown` — one replica

1. Read that replica's log: `The order saga worker ended with an error`, `Could not start the order saga worker`, or
   `Could not ask Temporal whether the order saga worker polls` (the probe itself failed: connectivity from that replica).
2. `temporal task-queue describe --task-queue "$MARKETPLACE_TEMPORAL_TASK_QUEUE"` (and `--task-queue-type activity`):
   is the replica's identity listed?
3. Restart the replica with a normal SIGTERM. Activities are idempotent (D-053) and are retried by the next worker.
   A replica with `MARKETPLACE_TEMPORAL_ENABLED=false` reports `0` on purpose: in production that is a misconfiguration.

### `RastaMarketplaceSagaNoLiveWorker` — nothing polls

No hold, settlement, refund or dispute release moves. Expected only during the gated deployment
([`marketplace-saga-deploy`](marketplace-saga-deploy.md), steps 2–4, every replica stopped); otherwise bring a replica
back, then work through `WorkerDown` above. `FinancialStepUnresolved` follows within the hour if orders were in flight.

### `RastaMarketplaceSagaFinancialStepUnresolved`

1. `rasta_marketplace_saga_unresolved_orders` by `reason` says which step. If the gauge is missing, the service is down
   or its sample is failing (log: `A saga state gauge could not be sampled`): the state is unknown — treat every
   in-flight order as unresolved until it is measured again.
2. If a liveness alert fires too, fix that first: the sagas resume at the next poll.
3. Find the orders (read-only, database clock):

   ```sql
   SELECT id, status, updated_at FROM "order"
   WHERE status IN ('PENDING', 'RECEIPT_CONFIRMED', 'SETTLING', 'CANCELLING')
   ORDER BY updated_at LIMIT 50;
   ```

   For `DISPUTE_RELEASE`: orders in `FUNDS_HELD`, `CONFIRMED` or `AWAITING_RECEIPT_CONFIRMATION` whose latest
   `saga_step` with activity `disputeObligation`/`markObligationDisputed` is newer than their latest
   `resolveObligationDispute` one.

4. `temporal workflow describe --workflow-id order-<orderId>`:
   - **Running, waiting** (a lost signal: the saga re-reads only every `MARKETPLACE_SAGA_RECHECK_HOURS`): send it any of
     its signals, e.g. `temporal workflow signal --workflow-id order-<orderId> --name orderConfirmed`. A signal only means
     "look now"; the saga decides from the order row (ADR-039 § 3).
   - **Running, an activity retrying**: economic-service is failing or refusing; its logs and
     `rasta_marketplace_economic_calls_total{outcome}` say which. The saga continues once it answers.
   - **Failed or completed while the order is not terminal** — `SETTLEMENT_EXHAUSTED`, `OBLIGATION_NOT_HELD`,
     `OBLIGATION_TERMS_MISMATCH`, a release refused because economic-service holds another dispute: a person decides, from
     economic-service's record of the obligation. After receipt there is no automatic financial compensation
     (`docs/08` § 8.4).
5. `DISPUTE_RELEASE` whose obligation economic-service already shows released (`HELD`, `PENDING_SETTLEMENT` or
   `SETTLED`, with this dispute's identity), with `Saga step resolveObligationDispute of order … took effect but was not
recorded` in the log: the release happened and only its record was lost. Escalate to engineering to record it; the
   alert keeps firing until the record exists, by design.

## Known limits

- A dispute mirror whose own outcome is unknown (`disputeObligation` failed after its retries, the workflow ended)
  while the order then returns to a party wait is not a `DISPUTE_RELEASE` (no mirror recorded); it is seen once the
  order next enters the saga's custody (`RECEIPT_CONFIRMED`, `CANCELLING`). A durable economic acknowledgement on the
  dispute would close it (proposed as a follow-up to FU-104).
- A dispute mirrored by a worker older than D-053 left no `saga_step` and is not counted.
- Local Prometheus loads these rules; notification routing is a deployment responsibility.
