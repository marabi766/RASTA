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
--
-- What was in force at an instant can no longer change once that instant has
-- passed (docs/23 D-057, Codex round 1 on #307):
--
--   - Two active rules of one scope — tenant or platform, line, optional type —
--     never overlap in time: three exclusion constraints, so create,
--     reactivation and window extension are all refused by the database, and
--     two concurrent writers cannot both succeed.
--   - A rule's terms never change, its status never changes once it has come
--     into force, and its end only moves at or after the present
--     (`trg_commission_rule_effective_dated`). Ending a rule is a `valid_to`.
--   - An obligation records the rule it was priced with when its source fact is
--     recorded (`transaction.pricing_*`), so settlement charges what was decided
--     then, whatever happens to the rules afterwards.
--   - `commission_pricing_cutover` holds the instant this migration ran. A source
--     fact that occurred before it is priced by the type-only rules exactly as
--     before, even if it is first recorded afterwards with a line.
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

-- Rules of one scope — whose (tenant, or the platform), which line, which type
-- — never overlap in time while active (Codex round 1 on #307, F1). Without
-- this, two rules for one subject at one instant left the rate to row order.
-- Different specificities may overlap by design: a tenant's rule over the
-- platform's, a type-narrowed rule over its whole line (`selectRule`).
--
-- The rules already present must satisfy it, or the migration stops here and
-- names the query that finds them; nothing is closed or chosen on anyone's
-- behalf. (The ALTER above already holds the table exclusively.)
DO $$
DECLARE overlapping BIGINT;
BEGIN
  SELECT count(*) INTO overlapping
    FROM "commission_rule" a
    JOIN "commission_rule" b
      ON a."id" < b."id"
     AND a."status" = 'ACTIVE' AND b."status" = 'ACTIVE'
     AND a."organization_id" IS NOT DISTINCT FROM b."organization_id"
     AND a."transaction_type" = b."transaction_type"
     AND (a."valid_to" IS NULL OR a."valid_to" > b."valid_from")
     AND (b."valid_to" IS NULL OR b."valid_to" > a."valid_from");
  IF overlapping > 0 THEN
    RAISE EXCEPTION
      'commission_rule holds % pair(s) of active rules for one organization and type in force at the same time. Find them with: SELECT a.id, b.id FROM commission_rule a JOIN commission_rule b ON a.id < b.id AND a.status = ''ACTIVE'' AND b.status = ''ACTIVE'' AND a.organization_id IS NOT DISTINCT FROM b.organization_id AND a.transaction_type = b.transaction_type AND (a.valid_to IS NULL OR a.valid_to > b.valid_from) AND (b.valid_to IS NULL OR b.valid_to > a.valid_from);',
      overlapping
      USING HINT = 'Close the one that should not apply (valid_to), then migrate (docs/23 D-057).';
  END IF;
END
$$;

-- `=` on text and enums inside a GiST exclusion constraint needs btree_gist. A
-- trusted extension, so the database owner can create it; the bootstrap also
-- installs it into every database, as it does for organization-service.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Half-open periods, [valid_from, valid_to): a rule closed at T and its
-- successor from T meet without overlapping. NULL organization is the
-- platform, which the empty string stands for here — so no organization id
-- may be empty.
ALTER TABLE "commission_rule"
  ADD CONSTRAINT "ck_commission_rule_organization_not_blank"
  CHECK ("organization_id" IS NULL OR "organization_id" <> '');

ALTER TABLE "commission_rule"
  ADD CONSTRAINT "ex_commission_rule_type_only_no_overlap"
  EXCLUDE USING gist (
    COALESCE("organization_id", '') WITH =,
    "transaction_type" WITH =,
    tsrange("valid_from", "valid_to", '[)') WITH &&
  ) WHERE ("status" = 'ACTIVE' AND "business_line" IS NULL);

ALTER TABLE "commission_rule"
  ADD CONSTRAINT "ex_commission_rule_line_no_overlap"
  EXCLUDE USING gist (
    COALESCE("organization_id", '') WITH =,
    "business_line" WITH =,
    tsrange("valid_from", "valid_to", '[)') WITH &&
  ) WHERE ("status" = 'ACTIVE' AND "business_line" IS NOT NULL AND "transaction_type" IS NULL);

ALTER TABLE "commission_rule"
  ADD CONSTRAINT "ex_commission_rule_line_type_no_overlap"
  EXCLUDE USING gist (
    COALESCE("organization_id", '') WITH =,
    "business_line" WITH =,
    "transaction_type" WITH =,
    tsrange("valid_from", "valid_to", '[)') WITH &&
  ) WHERE ("status" = 'ACTIVE' AND "business_line" IS NOT NULL AND "transaction_type" IS NOT NULL);

-- Effective-dated, enforced where every writer passes (Codex round 1 on #307,
-- F2). The service refuses the same things first, with a 422 that says why;
-- this is what holds when something writes around it. `valid_*` are UTC
-- timestamps without zone, so the clock is read the same way, to the
-- millisecond the columns keep.
CREATE OR REPLACE FUNCTION commission_rule_effective_dated() RETURNS TRIGGER AS $$
DECLARE at TIMESTAMP(3) := date_trunc('milliseconds', now() AT TIME ZONE 'UTC');
BEGIN
  IF (NEW."organization_id", NEW."business_line", NEW."transaction_type", NEW."rate_basis_points",
      NEW."min_amount_minor", NEW."max_amount_minor", NEW."valid_from")
     IS DISTINCT FROM
     (OLD."organization_id", OLD."business_line", OLD."transaction_type", OLD."rate_basis_points",
      OLD."min_amount_minor", OLD."max_amount_minor", OLD."valid_from") THEN
    RAISE EXCEPTION 'commission_rule terms never change: a new rate, scope or start is a new rule'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND OLD."valid_from" <= at THEN
    RAISE EXCEPTION 'a commission rule in force keeps its status: end it with valid_to'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."valid_to" IS DISTINCT FROM OLD."valid_to" THEN
    IF OLD."valid_to" IS NOT NULL AND OLD."valid_to" <= at THEN
      RAISE EXCEPTION 'a commission rule that has ended cannot be moved or reopened'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."valid_to" IS NOT NULL AND NEW."valid_to" < at THEN
      RAISE EXCEPTION 'a commission rule is ended from now on, never in the past'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_commission_rule_effective_dated"
  BEFORE UPDATE ON "commission_rule"
  FOR EACH ROW EXECUTE FUNCTION commission_rule_effective_dated();

-- -----------------------------------------------------------------------------
-- The pricing cutover: the instant line rules began to price (F3)
-- -----------------------------------------------------------------------------
-- One row, written here with the database clock. A source fact that occurred
-- before it — a maintenance approval given before this deployment and consumed
-- after it, say — is priced by the type-only rules that were in force for it,
-- exactly as before, even though it now arrives with a line.
CREATE TABLE "commission_pricing_cutover" (
  "id"                SMALLINT     NOT NULL DEFAULT 1,
  "line_pricing_from" TIMESTAMP(3) NOT NULL,
  "migration_name"    TEXT         NOT NULL,
  CONSTRAINT "commission_pricing_cutover_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_commission_pricing_cutover_single" CHECK ("id" = 1)
);

INSERT INTO "commission_pricing_cutover" ("id", "line_pricing_from", "migration_name")
VALUES (1, date_trunc('milliseconds', now() AT TIME ZONE 'UTC'), '20261016120000_commission_business_lines');

CREATE OR REPLACE FUNCTION reject_commission_pricing_cutover_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'the commission pricing cutover is fixed by its migration'
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_commission_pricing_cutover_fixed"
  BEFORE UPDATE OR DELETE ON "commission_pricing_cutover"
  FOR EACH ROW EXECUTE FUNCTION reject_commission_pricing_cutover_mutation();

-- -----------------------------------------------------------------------------
-- Obligations: the rule they were priced with, when their fact was recorded
-- -----------------------------------------------------------------------------
-- NULL on every existing row, which settlement prices as it always did (by the
-- rules in force at `occurred_at`, under the cutover). Set once, at creation,
-- for every obligation with a payee; never changed afterwards.
ALTER TABLE "transaction"
  ADD COLUMN "pricing_outcome" "CommissionOutcome",
  ADD COLUMN "pricing_rule_id" TEXT;

ALTER TABLE "transaction"
  ADD CONSTRAINT "ck_transaction_pricing"
  CHECK (CASE WHEN "pricing_outcome" = 'RULE_APPLIED' THEN "pricing_rule_id" IS NOT NULL
              ELSE "pricing_rule_id" IS NULL END);

ALTER TABLE "transaction"
  ADD CONSTRAINT "transaction_pricing_rule_id_fkey" FOREIGN KEY ("pricing_rule_id")
  REFERENCES "commission_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "transaction_pricing_rule_id_idx" ON "transaction"("pricing_rule_id");

CREATE OR REPLACE FUNCTION reject_transaction_repricing() RETURNS TRIGGER AS $$
BEGIN
  IF (NEW."pricing_outcome", NEW."pricing_rule_id") IS DISTINCT FROM
     (OLD."pricing_outcome", OLD."pricing_rule_id") THEN
    RAISE EXCEPTION 'a transaction keeps the pricing recorded with its source fact'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_transaction_pricing_fixed"
  BEFORE UPDATE OF "pricing_outcome", "pricing_rule_id" ON "transaction"
  FOR EACH ROW EXECUTE FUNCTION reject_transaction_repricing();

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
