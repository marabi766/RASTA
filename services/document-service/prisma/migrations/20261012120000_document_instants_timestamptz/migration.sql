-- D-048 / L7-37 pilot: every instant document-service stores becomes
-- TIMESTAMPTZ(3).
--
-- All seventeen DateTime columns of this schema hold an instant — a moment, not
-- a calendar day and not a local wall time — so all seventeen are converted and
-- none is left out:
--
--   upload_intent   expires_at, consumed_at, created_at
--   document        scanned_at, scan_queued_at, scan_next_attempt_at,
--                   scan_lease_expires_at, quarantined_at, deleted_at,
--                   created_at, updated_at
--   access_grant    granted_at, revoked_at
--   outbox_message  created_at, published_at, claim_expires_at, next_attempt_at
--
-- Until now each was `timestamp(3)`, a wall time with no zone. Prisma writes and
-- reads it as UTC and is right; raw SQL is not — `now() + make_interval(…)` in
-- the scan claim, `<= now()` in the outbox claim, a column default — because
-- PostgreSQL turns `timestamptz` into `timestamp` in the **session's** zone.
-- #214 pins every session to UTC; this removes the dependency instead.
--
-- Existing values are UTC wall times (that is what every writer stored), so
-- each is read `AT TIME ZONE 'UTC'`: the explicit form, correct whatever zone
-- this session happens to be in. The implicit cast would use the session's.
--
-- One ALTER TABLE per table, so each table is rewritten once, not once per
-- column. The rewrite holds ACCESS EXCLUSIVE on the table until COMMIT and
-- rebuilds every index on it (dropping the USING does not avoid it: the
-- typmod coercion still forces the rewrite, measured on PostgreSQL 16).
-- Indexes, CHECK constraints and the CURRENT_TIMESTAMP defaults are carried
-- over by PostgreSQL itself, under their own names and definitions.
--
-- **Run it with document-service stopped — every replica, for the whole run —
-- and start the service only after it commits** (docs/23 D-048 runbook). Two
-- reasons, both measured:
--
-- - Prisma sends this file as one implicit transaction, so each table's
--   ACCESS EXCLUSIVE lock is held until the whole migration commits, not until
--   its own ALTER ends: on the dev host 1,000,000 `document` rows took 46 s and
--   2,000,000 `outbox_message` rows 29 s, far past the 3 s a request waits at
--   the gateway. Size the maintenance window by the total.
-- - A connection that prepared a statement on one of these tables before the
--   conversion fails it afterwards — PostgreSQL refuses to re-plan a cached
--   statement whose result type changed ("cached plan must not change result
--   type", 0A000) and Prisma keeps the statement, so that connection fails the
--   same query until it is replaced (test/instants-timestamptz.int-spec.ts).
--
-- The two timeouts make a run fail closed, with nothing changed — the one
-- transaction undoes every ALTER before the failing one. `lock_timeout` stops
-- it waiting on whatever still holds a table (a replica left running, a long
-- transaction). `statement_timeout` bounds each rewrite at 30 s by default:
-- no deployed environment holds document data today, so it meets empty or
-- test-sized tables, and a bigger table than expected fails the run rather than
-- overrunning the window. An operator who sized a larger table raises it for
-- one run, without editing this file: `RASTA_MIGRATION_STATEMENT_TIMEOUT=15min
-- pnpm db:migrate` (scripts/prisma.mjs passes it as the session setting
-- `rasta.migration_statement_timeout`, read below). After a failure Prisma
-- refuses every deploy (P3009) until it is resolved — see the runbook.
SET LOCAL lock_timeout = '5s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '30s'),
                  true);

ALTER TABLE "upload_intent"
  ALTER COLUMN "expires_at"  TYPE TIMESTAMPTZ(3) USING "expires_at"  AT TIME ZONE 'UTC',
  ALTER COLUMN "consumed_at" TYPE TIMESTAMPTZ(3) USING "consumed_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "created_at"  TYPE TIMESTAMPTZ(3) USING "created_at"  AT TIME ZONE 'UTC';

ALTER TABLE "document"
  ALTER COLUMN "scanned_at"            TYPE TIMESTAMPTZ(3) USING "scanned_at"            AT TIME ZONE 'UTC',
  ALTER COLUMN "scan_queued_at"        TYPE TIMESTAMPTZ(3) USING "scan_queued_at"        AT TIME ZONE 'UTC',
  ALTER COLUMN "scan_next_attempt_at"  TYPE TIMESTAMPTZ(3) USING "scan_next_attempt_at"  AT TIME ZONE 'UTC',
  ALTER COLUMN "scan_lease_expires_at" TYPE TIMESTAMPTZ(3) USING "scan_lease_expires_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "quarantined_at"        TYPE TIMESTAMPTZ(3) USING "quarantined_at"        AT TIME ZONE 'UTC',
  ALTER COLUMN "deleted_at"            TYPE TIMESTAMPTZ(3) USING "deleted_at"            AT TIME ZONE 'UTC',
  ALTER COLUMN "created_at"            TYPE TIMESTAMPTZ(3) USING "created_at"            AT TIME ZONE 'UTC',
  ALTER COLUMN "updated_at"            TYPE TIMESTAMPTZ(3) USING "updated_at"            AT TIME ZONE 'UTC';

ALTER TABLE "access_grant"
  ALTER COLUMN "granted_at" TYPE TIMESTAMPTZ(3) USING "granted_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "revoked_at" TYPE TIMESTAMPTZ(3) USING "revoked_at" AT TIME ZONE 'UTC';

ALTER TABLE "outbox_message"
  ALTER COLUMN "created_at"       TYPE TIMESTAMPTZ(3) USING "created_at"       AT TIME ZONE 'UTC',
  ALTER COLUMN "published_at"     TYPE TIMESTAMPTZ(3) USING "published_at"     AT TIME ZONE 'UTC',
  ALTER COLUMN "claim_expires_at" TYPE TIMESTAMPTZ(3) USING "claim_expires_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "next_attempt_at"  TYPE TIMESTAMPTZ(3) USING "next_attempt_at"  AT TIME ZONE 'UTC';
