-- =============================================================================
-- economic-service — commission by business line (ADR-045; COM-011; docs/23 D-057)
--
-- A commissionable transaction says *why* the platform may earn from it — its
-- business line — apart from *how* the money moves, its type. A rule is written
-- for a line, optionally narrowed to one type, and the commission step records
-- whether a rule matched at all (`outcome`), so "no active rule" can never be
-- read as "a rule that computed zero".
--
-- Nothing is reinterpreted (ADR-045 Compliance: no retroactive effect):
--
--   - `transaction.business_line` is new and NULL on every existing row. No
--     line is derived from the type — a MARKETPLACE_ORDER may sell parts or
--     broker a service, and ADR-045 rejects that inference.
--   - Existing rules keep their type and get no line. They go on pricing the
--     transactions that carry no line, exactly as before, and nothing else.
--   - Existing commission rows get their `outcome` from the one fact that
--     already said it: a row the engine wrote with no rule (`rule_id` NULL,
--     rate 0, amount 0) is NO_ACTIVE_RULE, every other is RULE_APPLIED. A row
--     with no rule but a non-zero charge cannot be classified honestly, so the
--     migration refuses it rather than guess.
--
-- A posted commission becomes append-only (ADR-045 § 3): it is corrected by a
-- reversal entry, never by UPDATE or DELETE. With that, `rule_id`'s ON DELETE
-- SET NULL would be an impossible action, so it becomes RESTRICT — a rule that
-- priced a charge cannot be deleted (none ever is; rules are closed).
-- =============================================================================

SET LOCAL lock_timeout = '5s';

CREATE TYPE "BusinessLine" AS ENUM (
  'PARTS',
  'INSURANCE',
  'MAINTENANCE',
  'LOGISTICS',
  'PROCUREMENT',
  'CONSTRUCTION',
  'MARKETPLACE_SERVICE'
);

CREATE TYPE "CommissionOutcome" AS ENUM ('RULE_APPLIED', 'NO_ACTIVE_RULE');

-- -----------------------------------------------------------------------------
-- Transactions: the line the source sent, if any (docs/24 Q-130)
-- -----------------------------------------------------------------------------
ALTER TABLE "transaction" ADD COLUMN "business_line" "BusinessLine";

-- -----------------------------------------------------------------------------
-- Rules: a line, optionally one type within it
-- -----------------------------------------------------------------------------
ALTER TABLE "commission_rule"
  ADD COLUMN "business_line" "BusinessLine",
  ALTER COLUMN "transaction_type" DROP NOT NULL;

-- A rule must say what it prices. Every rule written since ADR-045 names a
-- line (the API requires it); a rule from before names a type. Neither would
-- be a rule that matches nothing — or, read carelessly, everything.
ALTER TABLE "commission_rule"
  ADD CONSTRAINT "ck_commission_rule_scope"
  CHECK ("business_line" IS NOT NULL OR "transaction_type" IS NOT NULL);

CREATE INDEX "commission_rule_business_line_status_valid_from_idx"
  ON "commission_rule"("business_line", "status", "valid_from");

-- -----------------------------------------------------------------------------
-- Commission: the line it was charged under, and what the step decided
-- -----------------------------------------------------------------------------
LOCK TABLE "commission" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE unclassifiable BIGINT;
BEGIN
  SELECT count(*) INTO unclassifiable FROM "commission"
   WHERE "rule_id" IS NULL AND ("rate_basis_points" <> 0 OR "amount_minor" <> 0);
  IF unclassifiable > 0 THEN
    RAISE EXCEPTION '% commission row(s) carry a charge but no rule; refusing to classify them', unclassifiable
      USING HINT = 'The engine never writes that shape. Find out which rule priced them before migrating.';
  END IF;
END
$$;

ALTER TABLE "commission"
  ADD COLUMN "business_line" "BusinessLine",
  ADD COLUMN "outcome" "CommissionOutcome";

UPDATE "commission"
   SET "outcome" = CASE WHEN "rule_id" IS NULL THEN 'NO_ACTIVE_RULE'::"CommissionOutcome"
                        ELSE 'RULE_APPLIED'::"CommissionOutcome" END;

ALTER TABLE "commission" ALTER COLUMN "outcome" SET NOT NULL;

-- NO_ACTIVE_RULE exactly when no rule is named, and then nothing was charged:
-- the outcome and the row can never tell two different stories.
ALTER TABLE "commission"
  ADD CONSTRAINT "ck_commission_outcome"
  CHECK (
    ("outcome" = 'NO_ACTIVE_RULE') = ("rule_id" IS NULL) AND
    ("outcome" <> 'NO_ACTIVE_RULE' OR ("rate_basis_points" = 0 AND "amount_minor" = 0))
  );

-- "What did this organization earn, per line, and where did no rule match?"
CREATE INDEX "commission_organization_id_business_line_outcome_idx"
  ON "commission"("organization_id", "business_line", "outcome");

ALTER TABLE "commission" DROP CONSTRAINT "commission_rule_id_fkey";
ALTER TABLE "commission"
  ADD CONSTRAINT "commission_rule_id_fkey" FOREIGN KEY ("rule_id")
  REFERENCES "commission_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION reject_commission_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'commission is append-only. Correct a posted commission with a reversal entry, never UPDATE/DELETE.'
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_commission_append_only"
  BEFORE UPDATE OR DELETE ON "commission"
  FOR EACH ROW EXECUTE FUNCTION reject_commission_mutation();
