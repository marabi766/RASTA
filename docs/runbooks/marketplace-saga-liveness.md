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
  `OPEN` on an order still `DISPUTED` (the operator decides; nothing is due yet). Recorded calls (FU-104, FU-145,
  #836 r1): the hold (`createObligation`, `subject` the order), the release, and every authorisation
  (`authoriseSettlement`), settlement (`settle`) and refund (`compensate`), each opened before the call and closed only
  by that attempt's own answer. A buyer's dispute and an operator's decision do not close one: they pause settlement and
  confirm nothing about a command already sent (#792 r2 F2). A confirmed refund also closes the authorisation and
  settlement rows of the same obligation (`REFUNDED` is terminal); a lookup that finds the order's own obligation closes
  its hold row, an empty one never does (a late commit is invisible to it); a refusal never does, on any attempt (FU-183, #836 r3 F1): economic-service frees the key on a refusal, so a send the record cannot see (an older worker's, unrecorded, before a reset scheduled attempt 1 again) can still claim it and commit.
- each row names the **scheduled command** that owns it (`command`, `command_scheduled_at`: the saga step key and when
  Temporal scheduled it, #836 r1 R1). Only the owner or a command scheduled later opens it again; an attempt of an older
  command is refused before it calls (`SAGA_CALL_SUPERSEDED`, non-retryable: the saga has moved past it), so its
  answer, a cached one included, cannot end a newer command's episode. The opening is one statement under the row's
  lock: a confirmation racing it lands wholly before (a new episode, aged from now) or after (it closes nothing).
- an order in a saga-custody status (`SAGA_CUSTODY` in `state-machine.ts`).

| `reason`            | The episode is …                                                                                          | Aged from                                                                      | The saga owes …                            |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| `PENDING`           | an order placed; the hold is not confirmed                                                                | when it left a party's hands, else its creation                                | the hold (`createObligation`), or `FAILED` |
| `RECEIPT_CONFIRMED` | an order confirmed by the buyer, or back after a failed settlement attempt                                | the same; a `RECEIPT_CONFIRMED ↔ SETTLING` bounce does not reset it            | authorisation and settlement               |
| `SETTLING`          | an order in a settlement attempt                                                                          | the same                                                                       | the settlement's outcome                   |
| `CANCELLING`        | an order cancelled, or refunded by a dispute decision                                                     | the same; `PENDING → CANCELLING` does not reset it                             | the refund (`compensate`)                  |
| `DISPUTE_RELEASE`   | an open `resolveObligationDispute` row: a dispute economic-service was told of, its release not confirmed | the dispute's decision; a row whose dispute row is missing, its opening        | the release (`resolveObligationDispute`)   |
| `UNCONFIRMED_CALL`  | an open call row: `createObligation`, `authoriseSettlement`, `settle`, `compensate`, or any other         | its first opening while open; a call confirmed and made again, its new opening | that call's outcome                        |

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
6. `UNCONFIRMED_CALL` (`authoriseSettlement`, `settle`, `compensate`; `subject` is the obligation): read the obligation
   at economic-service. Authorised (`PENDING_SETTLEMENT` or `SETTLED`) answers an authorisation; `SETTLED` with its
   settlement answers a settlement (record it on the order before closing: the money moved); `REFUNDED` answers all
   three. Anything else is still unanswered, and so is an obligation not found or a row however old: it stays open until
   the saga's next attempt gets an answer, or a person's decision (`docs/08` § 8.4) takes effect at economic-service and
   its state shows it. Close a row only on an answer economic-service shows, never on absence, the order's status or
   age (D-135); the same way and with the `generation` you read.
7. `UNCONFIRMED_CALL` `createObligation` (`subject` is the order) on an order `FAILED` or `CANCELLED`: the hold was
   sent and never answered, or refused (`INSUFFICIENT_BALANCE` and every other code: a refusal closes nothing, FU-183),
   and a lookup found nothing. **Never close this row by hand** (D-135). Nothing available today
   proves the create will not still commit: a request delayed before it claims its key can claim it at any later time,
   and economic-service starts the key's retention (`ECONOMIC_IDEMPOTENCY_TTL_HOURS`) at that claim, so no timeout,
   empty lookup, terminal status or waiting margin is proof. Instead:
   - Look up the order's obligation at economic-service (read-only), each time the alert is reviewed.
   - Found on the order's own terms and `HELD`: the buyer's money is held for an order that ended. Refund it by hand
     (`docs/08` § 8.4) and record it in the change record.
   - Anything else (its own in another status, a row on other terms, nothing): record the lookup and escalate to
     engineering with the order.
   - The row stays open, and the alert keeps firing for it, by design (fail closed). Closing it needs economic-service's
     claim-time fence (D-132, #812): a create past its deadline is refused at the claim. Closing after that fence is
     FU-161; until it is on main, no step closes this row.

## Known limits

- **First deploy:** the backfill of `20261105130000_saga_unconfirmed_call` gives a row to every dispute of an
  unfinished order, released or not, so `FinancialEpisodeOverdue` fires for releases that did happen: a backfilled row
  becomes overdue one hour after its dispute's decision (or its opening, if it has no decision), and the alert fires once
  that has held for five minutes — at once only for decisions already over an hour old. Rows of disputes still `OPEN` on
  orders still `DISPUTED` are not counted until decided. Expected: reconcile them (step 5) before treating the alert as a
  new incident.
- **Calls made before this deploy** have no record: an authorisation or settlement an older worker left unanswered is
  counted only while its order is `RECEIPT_CONFIRMED` or `SETTLING`, and a dispute raised on it still takes it out of
  the count. At the first deploy, list such orders read-only (`SELECT organization_id, id, status FROM "order" WHERE
receipt_confirmed_at IS NOT NULL AND status IN ('RECEIPT_CONFIRMED', 'SETTLING', 'DISPUTED')`) and reconcile them
  with economic-service; a backfill for them is the follow-up.
- An order a person moves out of a custody status by hand is not counted by status; its open call rows still are.
- A database clock run **forward** and then corrected leaves `saga_monitor_clock` ahead: ages read high (the alert fires
  early, never late) until the real clock catches up. To undo it, set the row to `clock_timestamp()` only once the
  clock is verified right: an episode overdue by the real clock stays overdue. Never lower it for any other reason.
- **Clocks.** The reference is the database's clock; an episode's start (`order_status_history.occurred_at`, a
  dispute's `resolved_at`, a row's `opened_at`) is written by the application. An episode keeps its start for as long as
  it lasts, so its age never falls and a counted episode is never cleared. It can be **late**: an application clock
  ahead of the database's delays every episode it starts by that lead, and a database clock set back by Δ holds the
  reference still for Δ, so an episode not yet over the hour waits up to Δ longer. Keep both on NTP; stamping starts
  with the database's clock is the follow-up. An application clock behind starts episodes early (alerts sooner).
- A refusal before anything is sent (an order with no recorded receipt) also leaves its authorisation row open: fail
  closed, the operator reconciles it. So does every refusal of an authorisation, settlement or refund, and a create
  refused `NOT_FOUND`, `FORBIDDEN`, `TENANT_MISMATCH` or `CONFLICT` (economic-service's replay guard answers the first
  three for a key that did commit), and every refused create, whatever its code or attempt (FU-183, #836 r3 F1): a send the record cannot see — an older
  worker's, unrecorded — can still claim the freed key, and a reset that scheduled attempt 1 again cannot see it either.
  A buyer refused for balance is therefore step 7, never closed by hand. Resets before the hold need no restriction for
  this record any more (the former rule "never reset while older workers run" is removed: no attempt closes on a
  refusal, so a reset cannot close one). Closing a refused create waits for economic-service's claim-time fence (D-132,
  #812) and the deadline #812 persists on the order: FU-161.
- Rows opened before #836 name no command: the first command to open one takes it, as every opening did before.
- Command order is Temporal's scheduling time of each activity (`scheduledTimestampMs`). Two commands of one operation
  on one subject are never scheduled in the same millisecond (the saga awaits each); a tie, or a Temporal clock that ran
  back between them, refuses the later one (`SAGA_CALL_SUPERSEDED`, non-retryable) before it calls; the row stays the earlier command's (fail closed, never an episode cleared). A refused settlement counts as a failed attempt and a refused release waits for its next round; a refused hold goes to the lookup; a refused authorisation, refund or dispute fails the workflow with the funds held and the row open: check the Temporal cluster's clock, then restart the saga.
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
