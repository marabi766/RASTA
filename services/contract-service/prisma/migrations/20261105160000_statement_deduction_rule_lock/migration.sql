-- FU-089: also protect inserts that bypass StatementRepository.rulesInForce. This trigger sorts
-- before tg_statement_deduction_guard, whose snapshot/amount checks remain authoritative.
-- Production locks all selected rules in C id order before inserting; this lock never upgrades.
CREATE FUNCTION "statement_deduction_lock_rule"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "deduction_rule"
    WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."deduction_rule_id"
      AND "retired_at" IS NULL
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ck_statement_deduction_configured: a deduction requires a rule still in force'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_statement_deduction_00_lock_rule"
  BEFORE INSERT ON "statement_deduction"
  FOR EACH ROW EXECUTE FUNCTION "statement_deduction_lock_rule"();
