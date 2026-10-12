-- Reverses 20261012120000_document_instants_timestamptz (D-048).
--
-- Each instant goes back to the UTC wall time it was before the migration —
-- `AT TIME ZONE 'UTC'` on a timestamptz is that wall time, whatever zone this
-- session is in — so a value written before the migration, or after it, reads
-- the same through Prisma on either side. Same lock budget as the forward
-- migration, and the same rewrite.
--
-- The code does not have to be rolled back first. Under a UTC session (#214)
-- either Prisma client reads and writes either column type correctly. The
-- service does have to be restarted afterwards, for the reason the forward
-- migration gives: a connection that prepared a statement on these tables
-- before the rollback fails it after.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "upload_intent"
  ALTER COLUMN "expires_at"  TYPE TIMESTAMP(3) USING "expires_at"  AT TIME ZONE 'UTC',
  ALTER COLUMN "consumed_at" TYPE TIMESTAMP(3) USING "consumed_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "created_at"  TYPE TIMESTAMP(3) USING "created_at"  AT TIME ZONE 'UTC';

ALTER TABLE "document"
  ALTER COLUMN "scanned_at"            TYPE TIMESTAMP(3) USING "scanned_at"            AT TIME ZONE 'UTC',
  ALTER COLUMN "scan_queued_at"        TYPE TIMESTAMP(3) USING "scan_queued_at"        AT TIME ZONE 'UTC',
  ALTER COLUMN "scan_next_attempt_at"  TYPE TIMESTAMP(3) USING "scan_next_attempt_at"  AT TIME ZONE 'UTC',
  ALTER COLUMN "scan_lease_expires_at" TYPE TIMESTAMP(3) USING "scan_lease_expires_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "quarantined_at"        TYPE TIMESTAMP(3) USING "quarantined_at"        AT TIME ZONE 'UTC',
  ALTER COLUMN "deleted_at"            TYPE TIMESTAMP(3) USING "deleted_at"            AT TIME ZONE 'UTC',
  ALTER COLUMN "created_at"            TYPE TIMESTAMP(3) USING "created_at"            AT TIME ZONE 'UTC',
  ALTER COLUMN "updated_at"            TYPE TIMESTAMP(3) USING "updated_at"            AT TIME ZONE 'UTC';

ALTER TABLE "access_grant"
  ALTER COLUMN "granted_at" TYPE TIMESTAMP(3) USING "granted_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "revoked_at" TYPE TIMESTAMP(3) USING "revoked_at" AT TIME ZONE 'UTC';

ALTER TABLE "outbox_message"
  ALTER COLUMN "created_at"       TYPE TIMESTAMP(3) USING "created_at"       AT TIME ZONE 'UTC',
  ALTER COLUMN "published_at"     TYPE TIMESTAMP(3) USING "published_at"     AT TIME ZONE 'UTC',
  ALTER COLUMN "claim_expires_at" TYPE TIMESTAMP(3) USING "claim_expires_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "next_attempt_at"  TYPE TIMESTAMP(3) USING "next_attempt_at"  AT TIME ZONE 'UTC';

-- Prisma will not re-apply a migration whose row is still in its ledger.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261012120000_document_instants_timestamptz';
