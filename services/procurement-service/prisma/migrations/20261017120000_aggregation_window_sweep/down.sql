-- =============================================================================
-- Reverse of `migration.sql` (COM-007 PR 2).
--
-- Refuses, and changes nothing, while the new columns hold something the old
-- schema cannot say: a CANCELLED aggregation (its who, when and why live only in
-- the cancellation columns), an ended window whose demands are still following
-- it (they would stay SUBMITTED under a REFERRED or LAPSED window for good: PR 1
-- has no sweeper to move them), or an ended window whose digest is still being
-- built (its end's event is not out yet, and PR 1 has nothing to finish it).
-- Otherwise it drops the indexes, the constraints and the columns, and puts back
-- PR 1's `demand_aggregation_guard` word for word. A finished digest is dropped:
-- the end's event carried it.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "demand_aggregation"
              WHERE "status" = 'CANCELLED' OR "demands_to_follow" > 0
                 OR "end_digest_state" IS NOT NULL) THEN
    RAISE EXCEPTION 'refusing to reverse 20261017120000_aggregation_window_sweep: a CANCELLED aggregation, a window whose demands are still following it or one whose end''s event waits for its digest would lose what only these columns say';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "demand_aggregation_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
       OR NEW."opened_at" IS DISTINCT FROM OLD."opened_at"
       OR NEW."window_hours" IS DISTINCT FROM OLD."window_hours"
       OR NEW."min_quantity" IS DISTINCT FROM OLD."min_quantity"
       OR NEW."shortfall_policy" IS DISTINCT FROM OLD."shortfall_policy"
       OR NEW."setting_version" IS DISTINCT FROM OLD."setting_version"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'ck_demand_aggregation_origin_immutable: what a window was opened with never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Only an OPEN window changes without leaving its status (a demand joins or leaves, the
    -- window is extended); a window that ended is history.
    IF NEW."status" = OLD."status" AND OLD."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'ck_demand_aggregation_transition: a % aggregation does not change', OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'OPEN' AND NEW."status" IN ('READY', 'REFERRED', 'LAPSED'))
      OR (OLD."status" = 'READY' AND NEW."status" IN ('RFQ_ISSUED', 'CANCELLED'))
    ) THEN
      RAISE EXCEPTION 'ck_demand_aggregation_transition: % -> % is not a transition', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- The window's contents are frozen once it ended (ADR-070 § 2): the demand set is final.
    IF OLD."status" <> 'OPEN'
       AND (NEW."total_quantity" IS DISTINCT FROM OLD."total_quantity"
            OR NEW."demand_count" IS DISTINCT FROM OLD."demand_count"
            OR NEW."closes_at" IS DISTINCT FROM OLD."closes_at"
            OR NEW."extension_count" IS DISTINCT FROM OLD."extension_count")
    THEN
      RAISE EXCEPTION 'ck_demand_aggregation_frozen: a window that ended keeps its contents'
        USING ERRCODE = 'check_violation';
    END IF;
    -- An extension only moves the end forward, one counted window at a time or more.
    IF NEW."closes_at" < OLD."closes_at" OR NEW."extension_count" < OLD."extension_count"
       OR ((NEW."closes_at" > OLD."closes_at") <> (NEW."extension_count" > OLD."extension_count"))
    THEN
      RAISE EXCEPTION 'ck_demand_aggregation_extension: a window is only ever extended, and every extension is counted'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'ck_demand_aggregation_version: every change moves the version by one'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_demand_aggregation_not_erasable: an aggregation is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP INDEX IF EXISTS "ix_demand_request_window_ids";
DROP INDEX IF EXISTS "ix_demand_aggregation_sweep_follow";
DROP INDEX IF EXISTS "ix_demand_aggregation_sweep_open";

ALTER TABLE "demand_aggregation" DROP CONSTRAINT IF EXISTS "ck_demand_aggregation_digest";
ALTER TABLE "demand_aggregation" DROP CONSTRAINT IF EXISTS "ck_demand_aggregation_cancelled";
ALTER TABLE "demand_aggregation" DROP CONSTRAINT IF EXISTS "ck_demand_aggregation_sweep_claim";
ALTER TABLE "demand_aggregation" DROP CONSTRAINT IF EXISTS "ck_demand_aggregation_follow";

ALTER TABLE "demand_aggregation"
  DROP COLUMN IF EXISTS "end_digest_counted",
  DROP COLUMN IF EXISTS "end_digest_cursor",
  DROP COLUMN IF EXISTS "end_digest_state",
  DROP COLUMN IF EXISTS "demand_ids_sha256",
  DROP COLUMN IF EXISTS "cancel_reason",
  DROP COLUMN IF EXISTS "cancelled_by",
  DROP COLUMN IF EXISTS "cancelled_at",
  DROP COLUMN IF EXISTS "sweep_next_attempt_at",
  DROP COLUMN IF EXISTS "sweep_attempts",
  DROP COLUMN IF EXISTS "sweep_fence",
  DROP COLUMN IF EXISTS "sweep_lease_until",
  DROP COLUMN IF EXISTS "demands_to_follow";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261017120000_aggregation_window_sweep';
