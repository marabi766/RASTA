# Runbook: marketplace saga worker liveness (FU-104)

**Severity:** 🔴 critical — no saga worker moves holds, settlements, refunds or dispute releases.
**Alerts:** `RastaMarketplaceSagaWorkerDown`, `RastaMarketplaceSagaNoLiveWorker`
(`infrastructure/docker/prometheus/rules/rasta-marketplace-alerts.yml`).
**Scope:** the order saga worker (`orderSaga` on `MARKETPLACE_TEMPORAL_TASK_QUEUE`, default `rasta-order`) inside every
marketplace-service replica.

---

## Why this alert is built on state

A worker that failed used to write one log line and nothing else. Liveness now comes from state:

| Series                             | Meaning                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rasta_marketplace_saga_worker_up` | Per replica. `1` only while the SDK reports the worker `RUNNING` **and** Temporal lists this worker's own identity (`marketplace-saga@<host>/<pid>/<uuid>`) as a poller of both the workflow and the activity task queue. Disabled, never started, ended, stopping, or a probe that failed: `0`. |

The start backlog (`rasta_marketplace_saga_start_backlog…`, [`marketplace-saga-deploy`](marketplace-saga-deploy.md)) is
read by every replica on a timer of its own, independent of start delivery. A sample that fails, that does not answer
within its own deadline (6 s), or that is older than 26 s by the process's monotonic clock **withdraws** its series
instead of leaving the last value, and a replica that is stopping withdraws it; the alert reads a missing series as
unknown and fires.

## What fires, and how fast

| Alert                              | Fires when                                                                                                       | At the latest                                                                                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RastaMarketplaceSagaWorkerDown`   | a replica reports `worker_up == 0` for 2 min                                                                     | `run()` failed or ended: 2 min + one scrape. Still `RUNNING` but no longer polling: Temporal drops a poller about 5 min after its last poll (5 min 9 s on the dev server), probed every 15 s, then 2 min — about 7.5 min. |
| `RastaMarketplaceSagaNoLiveWorker` | no replica reports `worker_up == 1` — all `0`, or no series at all (every replica down or unscraped) — for 2 min | as above; a replica that is gone stops reporting at its next scrape                                                                                                                                                       |

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
back, then work through `WorkerDown` above.

## Known limits

- The probe uses `DescribeTaskQueue` without enhanced mode; if Temporal ever lists only one partition's pollers, a live
  worker can read `0` (a false `WorkerDown`, never a false `1`).
- A run of the saga worker that ends by itself (no `stop()`) exits the process, which is restarted; a worker that never
  started keeps the replica up, reporting `worker_up 0`.
- The SDK's own shutdown signals are off (`shutdownSignals: []`): a SIGTERM reaches the worker only through the
  service's graceful shutdown, which calls `stop()`, so a normal stop is never read as the worker ending by itself.
- Local Prometheus loads these rules; notification routing is a deployment responsibility.
