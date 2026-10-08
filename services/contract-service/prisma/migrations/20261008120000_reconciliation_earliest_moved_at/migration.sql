-- =============================================================================
-- contract-service — the reconciliation task keeps the EARLIEST move's instant too (CON-003 PR 2
-- review round 10; docs/23 D-050).
--
-- A task coalesces every move that lands while it is open. It keeps the highest hierarchy version
-- (`moved_version`) — that is what a signature's recorded version is compared with — and, until
-- now, the instant of that move. But the D-050 window asks "could this signature have committed
-- after ANY of the moves was prepared", and the answer is decided by the EARLIEST of them: move A
-- before a signature's commit, move B (the higher version) after its deadline, coalesced, left the
-- later instant and excluded a signature that A raced.
--
-- `earliest_moved_at` is the least `moved_at` over every move coalesced into the task (the
-- coalescing statement takes LEAST). A task queued before this column existed has NULL and falls
-- back to `moved_at`, then `created_at`; the backfill below copies `moved_at` for the open ones.
-- =============================================================================

ALTER TABLE "policy_reconciliation_task" ADD COLUMN "earliest_moved_at" TIMESTAMPTZ(3);

UPDATE "policy_reconciliation_task"
   SET "earliest_moved_at" = "moved_at"
 WHERE "moved_at" IS NOT NULL;
