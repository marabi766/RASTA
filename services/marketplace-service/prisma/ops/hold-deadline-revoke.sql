-- FU-234: takes back the deadlines one backfill run gave (docs/runbooks/marketplace-saga-deploy.md,
-- "Legacy rows", Roll back). As the migrator, in ONE transaction (psql --single-transaction),
-- after `\set run_id <the run's runId>`, `\set operator <who>` and `\set ticket <the change>`
-- on the same input (scripts/psql-prisma-url.mjs passes no other -v): an unset one is a syntax
-- error, a blank one the revocation table's CHECK, and either rolls back everything.
--
-- Nothing is deleted: each deadline taken back is recorded in order_hold_deadline_revocation
-- beside the row that gave it (both append-only). Only a row that still has exactly that
-- deadline, no hold and its sends open is taken back; one that has since held or closed its
-- sends keeps its deadline, as what it proved stays proven. A second run finds nothing.
-- Disabling the fence's trigger takes an ACCESS EXCLUSIVE lock on "order": bounded below.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "order" DISABLE TRIGGER "trg_order_hold_fence_only_forward";
WITH taken AS (
  UPDATE "order" AS o SET "hold_not_after" = NULL
    FROM "order_hold_deadline_backfill" AS a
   WHERE a."run_id" = :'run_id'
     AND o."organization_id" = a."organization_id" AND o."id" = a."order_id"
     AND o."hold_not_after" = a."hold_not_after"
     AND o."economic_transaction_id" IS NULL AND o."hold_sends_closed_at" IS NULL
  RETURNING a."organization_id", a."order_id", a."hold_not_after"
)
INSERT INTO "order_hold_deadline_revocation"
  ("organization_id", "order_id", "hold_not_after", "revoked_by", "ticket")
SELECT "organization_id", "order_id", "hold_not_after", :'operator', :'ticket' FROM taken
RETURNING "organization_id", "order_id", "hold_not_after";
ALTER TABLE "order" ENABLE TRIGGER "trg_order_hold_fence_only_forward";
