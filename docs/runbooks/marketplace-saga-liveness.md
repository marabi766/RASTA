# Runbook: marketplace saga liveness and unresolved financial episodes (FU-104, #770 r2 F3)

**Severity:** 🔴 critical — money is held, or its outcome is unconfirmed, and nothing is moving it.
**Alerts:** `RastaMarketplaceSagaWorkerDown`, `RastaMarketplaceSagaNoLiveWorker`,
`RastaMarketplaceSagaFinancialEpisodeOverdue` (`infrastructure/docker/prometheus/rules/rasta-marketplace-alerts.yml`).
**Scope:** the order saga worker (`orderSaga` on `MARKETPLACE_TEMPORAL_TASK_QUEUE`, default `rasta-order`) inside every
marketplace-service replica, and the orders it owes a financial step.

---

## Why these alerts are built on state

A worker that failed used to write one log line and nothing else; an alert built on a retry counter cleared as soon as
the retries stopped, whether or not anything was resolved. Both now come from state:

| Series                                                  | Meaning                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rasta_marketplace_saga_worker_up`                      | Per replica. `1` only while the SDK reports the worker `RUNNING` **and** Temporal lists this worker's own identity (`marketplace-saga@<host>/<pid>/<uuid>`) as a poller of both the workflow and the activity task queue. Disabled, never started, ended, stopping, or a probe that failed: `0`.                                                                           |
| `rasta_marketplace_saga_unresolved_overdue`             | Unresolved financial episodes over an hour old. **The alert reads only this.** No `reason` label. Aged against `saga_monitor_clock`, a one-row reference every reader moves to `GREATEST(itself, clock_timestamp())`: it never runs back, so an episode once counted stays counted until it is resolved, whatever its reason becomes and whatever the database clock does. |
| `rasta_marketplace_saga_unresolved_orders{reason}`      | Unresolved episodes, by reason, for diagnosis. Read from the database every 10 s by every replica, whether or not it runs a worker.                                                                                                                                                                                                                                        |
| `rasta_marketplace_saga_unresolved_age_seconds{reason}` | How long the oldest of them has waited (against the same reference); `0` when none.                                                                                                                                                                                                                                                                                        |

An **episode** is one of:

- an open row of `saga_unconfirmed_call` (#769): a call to economic-service nothing has confirmed. One row per dispute, so
  a second dispute, a lost `saga_step` record or step times written by a clock that ran back cannot hide the first
  dispute's release. Counted whatever the order's status, terminal included. The one row not counted: a dispute still
  `OPEN` on an order still `DISPUTED` (the operator decides; nothing is due yet).
- an order in a saga-custody status (`SAGA_CUSTODY` in `state-machine.ts`).

| `reason`            | The episode is …                                                                                          | Aged from                                                               | The saga owes …                            |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| `PENDING`           | an order placed; the hold is not confirmed                                                                | when it left a party's hands, else its creation                         | the hold (`createObligation`), or `FAILED` |
| `RECEIPT_CONFIRMED` | an order confirmed by the buyer, or back after a failed settlement attempt                                | the same; a `RECEIPT_CONFIRMED ↔ SETTLING` bounce does not reset it     | authorisation and settlement               |
| `SETTLING`          | an order in a settlement attempt                                                                          | the same                                                                | the settlement's outcome                   |
| `CANCELLING`        | an order cancelled, or refunded by a dispute decision                                                     | the same; `PENDING → CANCELLING` does not reset it                      | the refund (`compensate`)                  |
| `DISPUTE_RELEASE`   | an open `resolveObligationDispute` row: a dispute economic-service was told of, its release not confirmed | the dispute's decision; a row whose dispute row is missing, its opening | the release (`resolveObligationDispute`)   |
| `UNCONFIRMED_CALL`  | an open row of any other operation (none is recorded yet; counted rather than dropped)                    | its first opening                                                       | that call's outcome                        |

One order can be two episodes at once (a release owed and the settlement after it): each is counted. A sample that
fails, that does not answer within its own deadline (6 s), or that is older than 26 s by the process's monotonic
clock **withdraws** its series instead of leaving the last value, and a replica that is stopping withdraws all of them;
every alert reads a missing series as unknown and fires.

## What fires, and how fast

| Alert                                         | Fires when                                                                                                       | At the latest                                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RastaMarketplaceSagaWorkerDown`              | a replica reports `worker_up == 0` for 2 min                                                                     | `run()` failed or ended: 2 min + one scrape. Still `RUNNING` but no longer polling: Temporal drops a poller about 5 min after its last poll (5 min 9 s on the dev server), probed every 15 s, then 2 min — about 7.5 min. |
| `RastaMarketplaceSagaNoLiveWorker`            | no replica reports `worker_up == 1` — all `0`, or no series at all (every replica down or unscraped) — for 2 min | as above; a replica that is gone stops reporting at its next scrape                                                                                                                                                       |
| `RastaMarketplaceSagaFinancialEpisodeOverdue` | some replica counts an episode over 1 h old, **or** no replica reports the count, for 5 min                      | 1 h 5 min after the episode began (+ up to 10 s of sampling), with the application and database clocks in step: see the clock limits below                                                                                |

`FinancialEpisodeOverdue` does **not** clear when the retries stop, when the saga workflow ends, when every worker or
the whole service dies, when an episode changes reason, or when the database clock is set back: it clears only when no
episode is over the hour any more (or a replica reports that again). It has no `reason` label, so a handoff
(`RECEIPT_CONFIRMED ↔ SETTLING`, `PENDING → CANCELLING`, a release confirmed while the settlement it unblocked is itself
overdue) is the same alert, and `absent(…)` carries the same empty label set, so a reporter dying keeps it firing with
no resolve in between. A second overdue episode does not re-notify: watch `rasta_marketplace_saga_unresolved_overdue`
and `…_orders{reason}` rise.

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
back, then work through `WorkerDown` above. `FinancialEpisodeOverdue` follows within the hour if orders were in flight.

### `RastaMarketplaceSagaFinancialEpisodeOverdue`

1. `rasta_marketplace_saga_unresolved_orders{reason}` and `…_age_seconds{reason}` say which reasons are owed and for how
   long. If the series are missing, the service is down or its sample is failing (log: `A saga state gauge could not be
sampled`, with `read` and `outcome`; `saga_monitor_clock has no row` means the reference row is gone: restore it with
   `INSERT INTO saga_monitor_clock (id, high_water) VALUES (1, clock_timestamp())` only if the clock is known good; the
   reference may then be lower than before, which can delay, never clear, an episode). The
   state is unknown: treat every in-flight order as unresolved until it is measured again.
2. If a liveness alert fires too, fix that first: the sagas resume at the next poll.
3. Find the episodes (read-only). The query is `SagaStartStore.unresolved()` in
   `services/marketplace-service/src/temporal/saga-start.store.ts`; per episode, with the same definition and reference:

   ```sql
   WITH clock AS (SELECT high_water AS now FROM saga_monitor_clock WHERE id = 1),
   episode AS (
     SELECT c.organization_id, c.order_id, c.operation AS what, c.subject, c.generation,
       COALESCE(CASE WHEN d.status <> 'OPEN' THEN d.resolved_at AT TIME ZONE 'UTC' END, c.opened_at) AS since
     FROM saga_unconfirmed_call c
     LEFT JOIN "order" o ON o.organization_id = c.organization_id AND o.id = c.order_id
     LEFT JOIN order_dispute d ON d.organization_id = c.organization_id AND d.order_id = c.order_id AND d.id = c.subject
     WHERE c.confirmed_at IS NULL
       AND NOT COALESCE(c.operation = 'resolveObligationDispute' AND d.status = 'OPEN' AND o.status = 'DISPUTED', false)
     UNION ALL
     SELECT o.organization_id, o.id, o.status::text, NULL, NULL,
       COALESCE((SELECT max(h.occurred_at) FROM order_status_history h
         WHERE h.organization_id = o.organization_id AND h.order_id = o.id AND h.kind = 'TRANSITION'
           AND h.from_status NOT IN ('PENDING', 'RECEIPT_CONFIRMED', 'SETTLING', 'CANCELLING')), o.created_at)
         AT TIME ZONE 'UTC'
     FROM "order" o WHERE o.status IN ('PENDING', 'RECEIPT_CONFIRMED', 'SETTLING', 'CANCELLING')
   )
   SELECT e.*, clock.now - e.since AS waited FROM episode e CROSS JOIN clock
   ORDER BY e.since LIMIT 50;
   ```

   `what` is the operation of an open record (`subject` is the dispute for a release) or the order's custody status.
   Run it on the primary: it reads `saga_monitor_clock` without moving it.

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
5. `DISPUTE_RELEASE` whose obligation economic-service already shows released for **this** dispute (its identity, not
   only the order; an economic-service that gave no identity cannot prove it: escalate to engineering): the release happened and only its confirmation was lost, or the row came from the migration's
   backfill. Close it as [`marketplace-saga-deploy`](marketplace-saga-deploy.md) § «رکورد فراخوانی‌های تأییدنشده» says,
   with the `generation` you read, and record it in the change record. A row a saga still waits on closes by itself at
   its next attempt. The alert keeps firing until the row is closed, by design (fail closed).

## Known limits

- **First deploy:** the backfill of `20261105130000_saga_unconfirmed_call` gives a row to every dispute of an
  unfinished order, released or not, so `FinancialEpisodeOverdue` fires at once for releases that did happen. Expected:
  reconcile them (step 5) before treating the alert as a new incident.
- Refund and settlement have no call record yet: `CANCELLING`, `RECEIPT_CONFIRMED` and `SETTLING` come from the order's
  status. A refund that fails after a confirmed release leaves the order `CANCELLING`, which is counted; an order a person
  moves out of those statuses by hand is not.
- A database clock run **forward** and then corrected leaves `saga_monitor_clock` ahead: ages read high (the alert fires
  early, never late) until the real clock catches up. To undo it, set the row to `clock_timestamp()` only once the
  clock is verified right: an episode overdue by the real clock stays overdue. Never lower it for any other reason.
- **Clocks.** The reference is the database's clock; an episode's start (`order_status_history.occurred_at`, a
  dispute's `resolved_at`, a row's `opened_at`) is written by the application. An episode keeps its start for as long as
  it lasts, so its age never falls and a counted episode is never cleared. It can be **late**: an application clock
  ahead of the database's delays every episode it starts by that lead, and a database clock set back by Δ holds the
  reference still for Δ, so an episode not yet over the hour waits up to Δ longer. Keep both on NTP; stamping starts
  with the database's clock is the follow-up. An application clock behind starts episodes early (alerts sooner).
- A party may move an order out of the saga's custody while its episode is overdue: a buyer disputing a settlement
  stuck in `RECEIPT_CONFIRMED` makes it `DISPUTED` (the operator decides now) and the alert can clear. After the
  decision the order is counted again, aged from the decision.
- A saga that replayed past its resume point without `DISPUTE_RESUME_PATCH` releases only at its next wake-up as
  `RECEIPT_CONFIRMED`/`CANCELLING`; until then its row stays open and counts as `DISPUTE_RELEASE`.
- The probe uses `DescribeTaskQueue` without enhanced mode; if Temporal ever lists only one partition's pollers, a live
  worker can read `0` (a false `WorkerDown`, never a false `1`).
- The unresolved query scans live orders and open rows every 10 s per replica under a 1 s statement timeout; past it
  the sample is withdrawn and the alert fires as unknown. Each sample first moves the one `saga_monitor_clock` row in a
  transaction of its own; if another session holds the row over 500 ms (one that died mid-update holds it until
  PostgreSQL drops its connection), every sample fails and the alert fires as unknown. A partial index on `order(status)` is the follow-up if that is ever slow.
- A run of the saga worker that ends by itself (no `stop()`) exits the process, which is restarted; a worker that never
  started keeps the replica up, reporting `worker_up 0`.
- **Rollback:** code older than this exports no `rasta_marketplace_saga_unresolved_overdue`, so with it the alert
  fires as unknown for as long as it runs: roll the rule file back with the code (and only then run `down.sql` of
  `20261106120000_saga_monitor_clock`).
- Local Prometheus loads these rules; notification routing is a deployment responsibility.
