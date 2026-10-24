-- Q-03: manual choice; no legal thresholds or defaults are introduced.
ALTER TABLE "tender"
  ADD COLUMN "estimated_cost_minor" BIGINT,
  ADD COLUMN "procurement_threshold_warning" TEXT,
  ADD COLUMN "procurement_threshold_policy_id" TEXT,
  ADD CONSTRAINT "ck_tender_estimate_nonnegative" CHECK ("estimated_cost_minor" >= 0),
  ADD CONSTRAINT "ck_tender_threshold_warning" CHECK (
    "procurement_threshold_warning" IS NULL OR
    ("procurement_threshold_warning" = 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE'
      AND "procurement_threshold_policy_id" IS NOT NULL AND "published_at" IS NOT NULL)
  );

-- The two fields being validated cannot change after publication, even through SQL.
CREATE FUNCTION guard_tender_procurement_estimate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."published_at" IS NOT NULL AND
     (NEW."estimated_cost_minor" IS DISTINCT FROM OLD."estimated_cost_minor"
      OR NEW."procurement_nature" IS DISTINCT FROM OLD."procurement_nature"
      OR NEW."procurement_threshold_warning" IS DISTINCT FROM OLD."procurement_threshold_warning"
      OR NEW."procurement_threshold_policy_id" IS DISTINCT FROM OLD."procurement_threshold_policy_id") THEN
    RAISE EXCEPTION 'ck_tender_procurement_frozen' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tg_tender_procurement_estimate BEFORE UPDATE ON "tender"
  FOR EACH ROW EXECUTE FUNCTION guard_tender_procurement_estimate();
