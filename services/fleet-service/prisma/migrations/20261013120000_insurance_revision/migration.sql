-- The replica's insurance revision, and a parked event made due at once
-- (#240 round 10).
--
-- `asset_ref.insurance_revision` counts the changes to a machine's insurance
-- state: its windows, its retained-coverage list, its lapses, its owner and its
-- ownership generation. Every verification of an INSURANCE_RECORDED (live or
-- parked) reads it before asset-service is asked, and its decision is applied
-- only if it is unchanged under the asset's lock. An answer given before
-- `insurance:clear-transferred` emptied the windows (which changes neither the
-- owner nor the generation) can then no longer restore one.
--
-- Kept by a trigger, not by the writers: every write to those columns bumps it,
-- the consumer's projections and the operator command's raw UPDATE alike, and a
-- writer added later cannot forget to. A write that leaves them as they were
-- does not: nothing an answer depends on has changed. The column cannot be set
-- directly; the trigger overrides any value written to it.
--
-- `insurance_pending_verification.next_attempt_at`: a transfer no longer
-- re-verifies the machine's parked events inside its Kafka handler; it sets this
-- to now() and the sweep decides them. NULL keeps the age rule.
--
-- Both columns are additive with constant defaults (no table rewrite). Existing
-- rows start at revision 0, which nothing in flight has read yet.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "asset_ref" ADD COLUMN "insurance_revision" BIGINT NOT NULL DEFAULT 0;

CREATE FUNCTION "asset_ref_insurance_revision"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."insurance_revision" := 0;
  ELSIF NEW."insurance_cover" IS DISTINCT FROM OLD."insurance_cover"
     OR NEW."retained_coverages" IS DISTINCT FROM OLD."retained_coverages"
     OR NEW."insurance_lapsed_coverages" IS DISTINCT FROM OLD."insurance_lapsed_coverages"
     OR NEW."insurance_lapsed_at" IS DISTINCT FROM OLD."insurance_lapsed_at"
     OR NEW."ownership_generation" IS DISTINCT FROM OLD."ownership_generation"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id" THEN
    NEW."insurance_revision" := OLD."insurance_revision" + 1;
  ELSE
    NEW."insurance_revision" := OLD."insurance_revision";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "asset_ref_insurance_revision"
  BEFORE INSERT OR UPDATE ON "asset_ref"
  FOR EACH ROW EXECUTE FUNCTION "asset_ref_insurance_revision"();

ALTER TABLE "insurance_pending_verification" ADD COLUMN "next_attempt_at" TIMESTAMPTZ(3);

COMMIT;
