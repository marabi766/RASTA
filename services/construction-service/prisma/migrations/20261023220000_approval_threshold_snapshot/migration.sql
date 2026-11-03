ALTER TABLE "tender_approval_request"
  ADD COLUMN "procurement_threshold_warning" TEXT,
  ADD COLUMN "procurement_threshold_policy_id" TEXT,
  ADD CONSTRAINT "ck_tender_approval_threshold_snapshot" CHECK (
    ("procurement_threshold_warning" IS NULL OR
      ("procurement_threshold_warning" = 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE' AND "procurement_threshold_policy_id" IS NOT NULL))
    AND ("workflow_key" = 'tender.publication' OR
      ("procurement_threshold_warning" IS NULL AND "procurement_threshold_policy_id" IS NULL)));

CREATE FUNCTION guard_approval_threshold_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."procurement_threshold_warning" IS DISTINCT FROM OLD."procurement_threshold_warning"
    OR NEW."procurement_threshold_policy_id" IS DISTINCT FROM OLD."procurement_threshold_policy_id" THEN
    RAISE EXCEPTION 'ck_tender_approval_threshold_snapshot_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tg_approval_threshold_snapshot BEFORE UPDATE ON "tender_approval_request"
  FOR EACH ROW EXECUTE FUNCTION guard_approval_threshold_snapshot();
