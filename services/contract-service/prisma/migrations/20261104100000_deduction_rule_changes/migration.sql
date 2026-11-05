-- =============================================================================
-- contract-service — changes to deduction rules under four eyes (CON-003-1, docs/24 Q-125, D-115).
--
-- `deduction_rule` stays the set of rules **in force**, with the same meaning for every reader. It
-- cuts what a contractor is paid, so from here on it has one way in and one way out:
--
--   * `deduction_rule_change` — one proposed change of an employer's rules: CREATE (a name, a rate
--     and a base) or RETIRE (a rule in force, and why). A person of the employer proposes it and
--     another person decides it (D-115: a platform `SYSTEM_ADMIN`; who may do so is the route's
--     check, CON-003-2). Four eyes has no switch: Q-125 makes it a product rule.
--   * A rule is inserted only from a change APPROVED in the same transaction, and says what that
--     change says. It is retired only by a RETIRE change APPROVED in the same transaction. A change
--     cannot be APPROVED without its effect: that is checked when the transaction commits.
--
-- What holds it, whatever the code forgets:
--
--   * a change is born PENDING_APPROVAL at version 1 and says nothing of a decision;
--   * what it proposes and who proposed it never change, it is never erased, and every update is
--     one legal move that takes the version up by exactly one, so a decision is never edited;
--   * `ck_deduction_rule_change_four_eyes` is `compareActors` (@rasta/nest-common) reading DISTINCT:
--     the same issuer and different people, on the subject and on the user id, each way. Anything
--     that is not provably another person is refused, so the identity is mandatory on both sides,
--     and blank by JavaScript's `trim`, which `compareActors` reads as absent, is refused too;
--   * only the proposer withdraws (`compareActors` reading SAME): someone else ending a proposal
--     rejects it, and a rejection says why;
--   * a name has one form, and names are compared by one key: see "the name of a rule";
--   * one pending CREATE per (organization, name key) and one pending RETIRE per rule;
--   * every foreign key names the organization, so a change cannot reach another employer's rule.
--
-- A CREATE named like a rule in force may be proposed: replacing a rule is a RETIRE and a CREATE,
-- decided one after the other. It cannot be approved while that name is in force
-- (`ux_deduction_rule_name_active` still decides).
--
-- `deduction_rule.approved_change_id` is NULL only for a rule written before this migration. No
-- route ever wrote one, so no deployment should hold any; one that does keeps it in force, and
-- retires it through a RETIRE change like any other. Only a name outside the one form below stops
-- this migration.
--
-- This migration opens no route and writes no row (CON-003-2 opens them). Every instant is
-- TIMESTAMPTZ(3) (D-048).
--
--   transitions: PENDING_APPROVAL>APPROVED PENDING_APPROVAL>REJECTED PENDING_APPROVAL>WITHDRAWN
-- =============================================================================

-- ---- the name of a rule ------------------------------------------------------
--
-- One form, shared with `src/deduction/deduction-rule-name.ts`: what is not provably in it is refused
-- by naming what is allowed, so a character Unicode adds tomorrow, or one nobody listed, stays out.
-- `test/deduction-rule-change.int-spec.ts` runs both over every code point and fails if they differ.
--
--   * printable ASCII, the Persian alphabet with its hamza letters, and ، ؛ ؟ ٪ « ». Digits are Latin
--     (CLAUDE.md); the Arabic ي ى ك, tatweel and presentation forms are not the form (the application
--     folds them first), nor is any other script, so a lookalike cannot be spelled at all;
--   * one space between words;
--   * the only mark is the U+0654 of «ـهٔ», only after heh;
--   * the only invisible character is the half-space (U+200C), only between Persian letters.
CREATE FUNCTION "deduction_rule_name_is_canonical"("candidate" TEXT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN length("candidate") BETWEEN 1 AND 200
    AND "candidate" ~ U&'^[\0020-\007E\00AB\00BB\060C\061B\061F\066A\0621-\063A\0641\0642\0644-\0648\067E\0686\0698\06A9\06AF\06CC\0654\200C]+$'
    AND "candidate" !~ U&'^[\0020\200C]|[\0020\200C]$|[\0020\200C]{2}'
    AND "candidate" !~ U&'(^|[^\0647])\0654'
    AND "candidate" !~ U&'(^|[^\0621-\063A\0641\0642\0644-\0648\067E\0686\0698\06A9\06AF\06CC\0654])\200C|\200C($|[^\0621-\063A\0641\0642\0644-\0648\067E\0686\0698\06A9\06AF\06CC])';

-- What makes two names one name. A half-space changes nothing a person can rely on seeing: after
-- ر or ا it does not even change the drawing. Both uniqueness indexes compare this, not the bytes.
CREATE FUNCTION "deduction_rule_name_key"("canonical_name" TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN replace("canonical_name", U&'\200C', '');

-- A CHECK or an index runs these as whoever writes the row.
GRANT EXECUTE ON FUNCTION "deduction_rule_name_is_canonical"(TEXT) TO rasta_contract;
GRANT EXECUTE ON FUNCTION "deduction_rule_name_key"(TEXT) TO rasta_contract;

-- CreateEnum
CREATE TYPE "DeductionRuleChangeKind" AS ENUM ('CREATE', 'RETIRE');

-- CreateEnum
CREATE TYPE "DeductionRuleChangeStatus" AS ENUM (
  'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'WITHDRAWN'
);

-- CreateTable
CREATE TABLE "deduction_rule_change" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "kind" "DeductionRuleChangeKind" NOT NULL,
    "name" TEXT,
    "rate_bp" INTEGER,
    "base" TEXT,
    "deduction_rule_id" TEXT,
    "reason" TEXT,
    "status" "DeductionRuleChangeStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "proposed_at" TIMESTAMPTZ(3) NOT NULL,
    "proposed_by" TEXT NOT NULL,
    "proposed_by_issuer" TEXT NOT NULL,
    "proposed_by_subject" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" TEXT,
    "decided_by_issuer" TEXT,
    "decided_by_subject" TEXT,
    "decision_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "deduction_rule_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_deduction_rule_change_org_id"
  ON "deduction_rule_change"("organization_id", "id");
CREATE UNIQUE INDEX "ux_deduction_rule_change_pending_create"
  ON "deduction_rule_change"("organization_id", "deduction_rule_name_key"("name"))
  WHERE "status" = 'PENDING_APPROVAL' AND "kind" = 'CREATE';
CREATE UNIQUE INDEX "ux_deduction_rule_change_pending_retire"
  ON "deduction_rule_change"("organization_id", "deduction_rule_id")
  WHERE "status" = 'PENDING_APPROVAL' AND "kind" = 'RETIRE';

ALTER TABLE "deduction_rule_change" ADD CONSTRAINT "deduction_rule_change_rule_fkey"
  FOREIGN KEY ("organization_id", "deduction_rule_id")
  REFERENCES "deduction_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Each must hold something other than what JavaScript's `trim` removes. btrim() strips only spaces, and
-- `compareActors` treats a tab or a no-break space as absent: the two must not disagree on who acted.
ALTER TABLE "deduction_rule_change" ADD CONSTRAINT "ck_deduction_rule_change_text_not_blank"
  CHECK ("id" ~ U&'[^\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]' AND "organization_id" ~ U&'[^\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
         AND "proposed_by" ~ U&'[^\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
         AND "proposed_by_issuer" ~ U&'[^\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
         AND "proposed_by_subject" ~ U&'[^\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
         AND ("decided_by" IS NULL
              OR ("decided_by" ~ U&'[^\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
                  AND "decided_by_issuer" ~ U&'[^\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
                  AND "decided_by_subject" ~ U&'[^\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]')));

-- CREATE says what the rule will be and names no rule; RETIRE names the rule and says why.
ALTER TABLE "deduction_rule_change" ADD CONSTRAINT "ck_deduction_rule_change_kind"
  CHECK (("kind" = 'CREATE' AND num_nonnulls("name", "rate_bp", "base") = 3
          AND "deduction_rule_id" IS NULL AND "reason" IS NULL)
         OR ("kind" = 'RETIRE' AND num_nonnulls("name", "rate_bp", "base") = 0
             AND "deduction_rule_id" IS NOT NULL AND "reason" IS NOT NULL));

-- At least the limits of `ck_deduction_rule_name` and `ck_deduction_rule_rate`, so an approved change
-- always fits its rule. The name is in its one form before anything compares it.
ALTER TABLE "deduction_rule_change" ADD CONSTRAINT "ck_deduction_rule_change_name"
  CHECK ("name" IS NULL OR "deduction_rule_name_is_canonical"("name"));

ALTER TABLE "deduction_rule_change" ADD CONSTRAINT "ck_deduction_rule_change_rate"
  CHECK ("rate_bp" IS NULL OR ("rate_bp" >= 1 AND "rate_bp" <= 10000));

ALTER TABLE "deduction_rule_change" ADD CONSTRAINT "ck_deduction_rule_change_base"
  CHECK ("base" IS NULL OR "base" = 'GROSS');

-- Both reasons are bounded free text; only a rejection has a decision reason, and it must.
ALTER TABLE "deduction_rule_change" ADD CONSTRAINT "ck_deduction_rule_change_reason"
  CHECK (("reason" IS NULL
          OR ("reason" ~ U&'[^\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]' AND length("reason") <= 500
              AND "reason" !~ U&'[\061C\200E\200F\202A-\202E\2066-\2069]'))
         AND ("decision_reason" IS NULL
              OR ("decision_reason" ~ U&'[^\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]' AND length("decision_reason") <= 500
                  AND "decision_reason" !~ U&'[\061C\200E\200F\202A-\202E\2066-\2069]'))
         AND (("status" = 'REJECTED') = ("decision_reason" IS NOT NULL)));

-- A pending change has no decision; any other has all of it.
ALTER TABLE "deduction_rule_change" ADD CONSTRAINT "ck_deduction_rule_change_decision"
  CHECK (CASE WHEN "status" = 'PENDING_APPROVAL'
              THEN num_nonnulls("decided_at", "decided_by", "decided_by_issuer", "decided_by_subject") = 0
              ELSE num_nonnulls("decided_at", "decided_by", "decided_by_issuer", "decided_by_subject") = 4
         END);

ALTER TABLE "deduction_rule_change" ADD CONSTRAINT "ck_deduction_rule_change_timestamps"
  CHECK ("decided_at" IS NULL OR "decided_at" >= "proposed_at");

ALTER TABLE "deduction_rule_change" ADD CONSTRAINT "ck_deduction_rule_change_version"
  CHECK ("version" >= 1);

-- `compareActors` reading DISTINCT, in SQL: another issuer proves nothing (a subject is only unique
-- within its issuer), so it is refused.
ALTER TABLE "deduction_rule_change" ADD CONSTRAINT "ck_deduction_rule_change_four_eyes"
  CHECK ("status" NOT IN ('APPROVED', 'REJECTED')
         OR ("decided_by_issuer" = "proposed_by_issuer"
             AND "decided_by_subject" <> "proposed_by_subject"
             AND "decided_by" <> "proposed_by"
             AND "decided_by" <> "proposed_by_subject"
             AND "proposed_by" <> "decided_by_subject"));

-- `compareActors` reading SAME, in SQL.
ALTER TABLE "deduction_rule_change" ADD CONSTRAINT "ck_deduction_rule_change_withdrawn_by_proposer"
  CHECK ("status" <> 'WITHDRAWN'
         OR "decided_by" = "proposed_by"
         OR "decided_by" = "proposed_by_subject"
         OR "proposed_by" = "decided_by_subject"
         OR ("decided_by_issuer" = "proposed_by_issuer"
             AND "decided_by_subject" = "proposed_by_subject"));

-- Born pending, at version 1. A RETIRE names a rule in force: FOR SHARE waits for an approval of
-- this rule that is committing, and then sees it retired. The approval's guard below takes the rule
-- before it moves its change, so this lock and the pending index cannot deadlock with it.
CREATE FUNCTION "deduction_rule_change_insert_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM 'PENDING_APPROVAL' OR NEW."version" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'ck_deduction_rule_change_born_pending: a change is born PENDING_APPROVAL at version 1'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'RETIRE' THEN
    PERFORM 1 FROM "deduction_rule"
      WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."deduction_rule_id"
        AND "retired_at" IS NULL
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ck_deduction_rule_change_rule_in_force: only a rule of this organization in force can be retired'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_deduction_rule_change_insert"
  BEFORE INSERT ON "deduction_rule_change"
  FOR EACH ROW EXECUTE FUNCTION "deduction_rule_change_insert_guard"();

-- The legal moves, mirrored by `src/deduction/deduction-rule-change.state-machine.ts`; its spec and
-- `test/deduction-rule-change.int-spec.ts` fail if the two differ.
CREATE FUNCTION "deduction_rule_change_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."name" IS DISTINCT FROM OLD."name"
       OR NEW."rate_bp" IS DISTINCT FROM OLD."rate_bp"
       OR NEW."base" IS DISTINCT FROM OLD."base"
       OR NEW."deduction_rule_id" IS DISTINCT FROM OLD."deduction_rule_id"
       OR NEW."reason" IS DISTINCT FROM OLD."reason"
       OR NEW."proposed_at" IS DISTINCT FROM OLD."proposed_at"
       OR NEW."proposed_by" IS DISTINCT FROM OLD."proposed_by"
       OR NEW."proposed_by_issuer" IS DISTINCT FROM OLD."proposed_by_issuer"
       OR NEW."proposed_by_subject" IS DISTINCT FROM OLD."proposed_by_subject"
    THEN
      RAISE EXCEPTION 'ck_deduction_rule_change_immutable: what was proposed, and by whom, never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('APPROVED', 'REJECTED', 'WITHDRAWN')) THEN
      RAISE EXCEPTION 'ck_deduction_rule_change_transition: a change cannot move from % to %', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" IS DISTINCT FROM OLD."version" + 1 THEN
      RAISE EXCEPTION 'ck_deduction_rule_change_version_step: every move takes the version up by one'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Lock order: the rule, then the change's move. A proposal holding FOR SHARE on the rule meets
    -- this change still live in the pending index and is refused at once instead of waiting on us.
    -- NO KEY: a statement naming the rule (a foreign key's KEY SHARE) is not held up.
    IF NEW."status" = 'APPROVED' AND NEW."kind" = 'RETIRE' THEN
      PERFORM 1 FROM "deduction_rule"
        WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."deduction_rule_id"
        FOR NO KEY UPDATE;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_deduction_rule_change_not_erasable: a change is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_deduction_rule_change_guard"
  BEFORE UPDATE OR DELETE ON "deduction_rule_change"
  FOR EACH ROW EXECUTE FUNCTION "deduction_rule_change_guard"();

CREATE TRIGGER "tg_deduction_rule_change_no_truncate"
  BEFORE TRUNCATE ON "deduction_rule_change"
  FOR EACH STATEMENT EXECUTE FUNCTION "deduction_rule_change_guard"();

-- ---- deduction_rule ----------------------------------------------------------

-- AlterTable
ALTER TABLE "deduction_rule" ADD COLUMN "approved_change_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ux_deduction_rule_approved_change"
  ON "deduction_rule"("organization_id", "approved_change_id");

-- The same form and the same key for what is in force. A new rule says its change's name; this is for
-- a rule from before this migration: one not in the form stops the migration for a person to decide,
-- since it could otherwise stand in force beside the same name.
ALTER TABLE "deduction_rule" ADD CONSTRAINT "ck_deduction_rule_name_canonical"
  CHECK ("deduction_rule_name_is_canonical"("name"));

DROP INDEX "ux_deduction_rule_name_active";
CREATE UNIQUE INDEX "ux_deduction_rule_name_active"
  ON "deduction_rule"("organization_id", "deduction_rule_name_key"("name"))
  WHERE "retired_at" IS NULL;

ALTER TABLE "deduction_rule" ADD CONSTRAINT "deduction_rule_approved_change_fkey"
  FOREIGN KEY ("organization_id", "approved_change_id")
  REFERENCES "deduction_rule_change"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A rule comes only from a CREATE change approved in this transaction, says what it says, and is
-- born in force: it leaves force only by a RETIRE.
CREATE FUNCTION "deduction_rule_insert_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."retired_at" IS NOT NULL THEN
    RAISE EXCEPTION 'ck_deduction_rule_born_in_force: a deduction rule is retired only by an approved change'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM "deduction_rule_change" c
    WHERE c."organization_id" = NEW."organization_id"
      AND c."id" = NEW."approved_change_id"
      AND c."kind" = 'CREATE'
      AND c."status" = 'APPROVED'
      AND c."name" = NEW."name"
      AND c."rate_bp" = NEW."rate_bp"
      AND c."base" = NEW."base"
      AND c."decided_at" = NEW."created_at"
      AND c."proposed_by" = NEW."created_by";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ck_deduction_rule_approved_change: a deduction rule comes only from the approved change that says it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_deduction_rule_insert"
  BEFORE INSERT ON "deduction_rule"
  FOR EACH ROW EXECUTE FUNCTION "deduction_rule_insert_guard"();

-- What 20261015120000 kept, and now the change that made the rule, and the only way it is retired.
CREATE OR REPLACE FUNCTION "deduction_rule_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."name" IS DISTINCT FROM OLD."name"
       OR NEW."rate_bp" IS DISTINCT FROM OLD."rate_bp"
       OR NEW."base" IS DISTINCT FROM OLD."base"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."approved_change_id" IS DISTINCT FROM OLD."approved_change_id"
       OR (OLD."retired_at" IS NOT NULL AND NEW."retired_at" IS DISTINCT FROM OLD."retired_at")
    THEN
      RAISE EXCEPTION 'ck_deduction_rule_immutable: a deduction rule never changes; it is only retired, once'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."retired_at" IS NULL AND NEW."retired_at" IS NOT NULL THEN
      PERFORM 1 FROM "deduction_rule_change" c
        WHERE c."organization_id" = NEW."organization_id"
          AND c."deduction_rule_id" = NEW."id"
          AND c."kind" = 'RETIRE'
          AND c."status" = 'APPROVED'
          AND c."decided_at" = NEW."retired_at";
      IF NOT FOUND THEN
        RAISE EXCEPTION 'ck_deduction_rule_retire_approved: a deduction rule is retired only by an approved change'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_deduction_rule_not_erasable: a deduction rule is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- An approval without its effect does not commit: the CREATE has its rule, the RETIRE its retired rule.
CREATE FUNCTION "deduction_rule_change_effect"() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" = 'CREATE' THEN
    PERFORM 1 FROM "deduction_rule" r
      WHERE r."organization_id" = NEW."organization_id" AND r."approved_change_id" = NEW."id";
  ELSE
    PERFORM 1 FROM "deduction_rule" r
      WHERE r."organization_id" = NEW."organization_id" AND r."id" = NEW."deduction_rule_id"
        AND r."retired_at" = NEW."decided_at";
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ck_deduction_rule_change_effect: an approved change has its effect in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_deduction_rule_change_effect"
  AFTER UPDATE ON "deduction_rule_change"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" = 'APPROVED')
  EXECUTE FUNCTION "deduction_rule_change_effect"();
