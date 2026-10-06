-- =============================================================================
-- contract-service — amendments and milestones (CON-003 PR 3, ADR-068 § 9, Q-100).
--
-- Five things:
--
--   * `amendment` — a change to the price of a SIGNED contract, proposed by the employer. It
--     carries a signed amount delta in minor units (strictly POSITIVE for now: docs/24 Q-100 asks
--     whether a reduction exists; until it answers, the database refuses one), a closed reason code
--     and a bounded bidi-safe reason text. PROPOSED → EFFECTIVE, and nothing else: it becomes
--     effective when both parties have signed it, and an effective amendment never changes.
--   * `amendment_signature` — one row per side that signed an amendment, the same record as
--     `contract_signature` (who, for which party, under which configured authority, the hierarchy
--     evidence and version): the employer's side under the `contract.signature` policy in force,
--     the contractor's under its own CONTRACTOR role. Written once, never changed.
--   * `amendment_signature_review` — an employer amendment signature a later ORGANIZATION_MOVED may
--     have raced (D-050): flagged, never revoked. The same append-only record as
--     `signature_authority_review`.
--   * `milestone` — a planned milestone of a SIGNED contract: a title, a planned DATE and an
--     optional planned share in basis points. Edited by the employer until a statement refers to it
--     (`first_referenced_at`, set by the statement change of PR 4 and never by this one).
--   * `contract.amendments_total_minor` and `contract.approved_total_minor` — the two counters of
--     the ADR-068 § 5 cap invariant, `approved_total_minor <= amount_minor + amendments_total_minor`,
--     kept by the database. This change moves only the first, only when an amendment becomes
--     effective, and only to the exact sum of the effective deltas; the second is PR 4's and stays 0.
--
-- `contract_guard` is replaced so the database keeps all of that whatever a later write path
-- forgets. Every instant is TIMESTAMPTZ(3) (D-048); a planned date is a DATE, never an instant.
--
--   amendment transitions: PROPOSED>EFFECTIVE
-- =============================================================================

-- CreateEnum
CREATE TYPE "AmendmentStatus" AS ENUM ('PROPOSED', 'EFFECTIVE');

-- ---- contract: the cap counters ----------------------------------------------

ALTER TABLE "contract"
  ADD COLUMN "amendments_total_minor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "approved_total_minor" BIGINT NOT NULL DEFAULT 0;

-- The amendments only ever add (Q-100), so the total is never negative, and it is bounded so that
-- `amount + total` — the cap — can never overflow a bigint. This constraint's name sorts before
-- the cap's, and PostgreSQL tests CHECKs by name, so the overflow is refused here, not by an
-- arithmetic error in the next one.
ALTER TABLE "contract" ADD CONSTRAINT "ck_contract_amendments_total"
  CHECK ("amendments_total_minor" >= 0
         AND "amendments_total_minor" <= 9223372036854775807 - "amount_minor");

-- The ADR-068 § 5 invariant: what has been approved never exceeds the amount plus the amendments.
ALTER TABLE "contract" ADD CONSTRAINT "ck_contract_approved_cap"
  CHECK ("approved_total_minor" >= 0
         AND "approved_total_minor" <= "amount_minor" + "amendments_total_minor");

-- ---- amendment ---------------------------------------------------------------

-- CreateTable
CREATE TABLE "amendment" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "amendment_number" INTEGER NOT NULL,
    "delta_minor" BIGINT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "reason_text" TEXT NOT NULL,
    "status" "AmendmentStatus" NOT NULL DEFAULT 'PROPOSED',
    "proposed_by" TEXT NOT NULL,
    "proposed_at" TIMESTAMPTZ(3) NOT NULL,
    "proposed_correlation_id" TEXT NOT NULL,
    "effective_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "amendment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_amendment_org_id" ON "amendment"("organization_id", "id");
CREATE UNIQUE INDEX "ux_amendment_number" ON "amendment"("organization_id", "contract_id", "amendment_number");

-- AddForeignKey
ALTER TABLE "amendment" ADD CONSTRAINT "amendment_organization_id_contract_id_fkey"
  FOREIGN KEY ("organization_id", "contract_id") REFERENCES "contract"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "amendment" ADD CONSTRAINT "ck_amendment_text_not_blank"
  CHECK (btrim("organization_id") <> '' AND btrim("contract_id") <> ''
         AND btrim("proposed_by") <> '' AND btrim("proposed_correlation_id") <> '');

-- Money is a bigint of minor units. An amendment adds to the price: a reduction (and a zero) is
-- refused until the owner answers Q-100 — lifting this is a migration, not a setting.
ALTER TABLE "amendment" ADD CONSTRAINT "ck_amendment_delta_positive"
  CHECK ("delta_minor" > 0);

ALTER TABLE "amendment" ADD CONSTRAINT "ck_amendment_number_positive"
  CHECK ("amendment_number" >= 1 AND "version" >= 1);

-- The reason: a code from the closed list the configuration owns (CONTRACT_AMENDMENT_REASON_CODES),
-- so the database keeps its shape only, and a bounded text without bidirectional control characters.
ALTER TABLE "amendment" ADD CONSTRAINT "ck_amendment_reason"
  CHECK ("reason_code" ~ '^[A-Z][A-Z0-9_]{1,63}$'
         AND btrim("reason_text") <> '' AND length("reason_text") <= 1000
         AND "reason_text" !~ '[؜‎‏‪-‮⁦-⁩]');

-- An amendment is effective exactly when it has an effective instant, not before it was proposed.
ALTER TABLE "amendment" ADD CONSTRAINT "ck_amendment_effective"
  CHECK (("status" = 'EFFECTIVE') = ("effective_at" IS NOT NULL)
         AND ("effective_at" IS NULL OR "effective_at" >= "proposed_at")
         AND "updated_at" >= "proposed_at");

-- ---- amendment_signature -----------------------------------------------------

-- CreateTable
CREATE TABLE "amendment_signature" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "amendment_id" TEXT NOT NULL,
    "side" "ContractSide" NOT NULL,
    "signer_organization_id" TEXT NOT NULL,
    "signed_by" TEXT NOT NULL,
    "signed_by_issuer" TEXT,
    "signed_by_subject" TEXT,
    "authority_role" TEXT NOT NULL,
    "signed_at" TIMESTAMPTZ(3) NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "policy_id" TEXT,
    "policy_version" INTEGER,
    "hierarchy_author_organization_id" TEXT,
    "hierarchy_answer" TEXT,
    "hierarchy_read_at" TIMESTAMPTZ(3),
    "hierarchy_commit_deadline" TIMESTAMPTZ(3),
    "hierarchy_version" BIGINT,

    CONSTRAINT "amendment_signature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_amendment_signature_side" ON "amendment_signature"("organization_id", "amendment_id", "side");
CREATE INDEX "ix_amendment_signature_policy" ON "amendment_signature"("organization_id", "policy_id");

-- AddForeignKey
ALTER TABLE "amendment_signature" ADD CONSTRAINT "amendment_signature_organization_id_contract_id_fkey"
  FOREIGN KEY ("organization_id", "contract_id") REFERENCES "contract"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "amendment_signature" ADD CONSTRAINT "amendment_signature_organization_id_amendment_id_fkey"
  FOREIGN KEY ("organization_id", "amendment_id") REFERENCES "amendment"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "amendment_signature" ADD CONSTRAINT "amendment_signature_organization_id_policy_id_fkey"
  FOREIGN KEY ("organization_id", "policy_id") REFERENCES "approval_policy"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "amendment_signature" ADD CONSTRAINT "ck_amendment_signature_text_not_blank"
  CHECK (btrim("organization_id") <> '' AND btrim("contract_id") <> ''
         AND btrim("amendment_id") <> '' AND btrim("signer_organization_id") <> ''
         AND btrim("signed_by") <> '' AND btrim("authority_role") <> ''
         AND btrim("correlation_id") <> '');

ALTER TABLE "amendment_signature" ADD CONSTRAINT "ck_amendment_signature_identity"
  CHECK (("signed_by_issuer" IS NULL) = ("signed_by_subject" IS NULL)
         AND ("signed_by_issuer" IS NULL
              OR (btrim("signed_by_issuer") <> '' AND btrim("signed_by_subject") <> '')));

ALTER TABLE "amendment_signature" ADD CONSTRAINT "ck_amendment_signature_authority_role"
  CHECK ("authority_role" ~ '^[A-Z][A-Z_]*$');

-- The employer's side is authorised by a policy and names it; the contractor's has none.
ALTER TABLE "amendment_signature" ADD CONSTRAINT "ck_amendment_signature_policy"
  CHECK (("side" = 'EMPLOYER') = ("policy_id" IS NOT NULL)
         AND ("policy_id" IS NULL) = ("policy_version" IS NULL)
         AND ("policy_version" IS NULL OR "policy_version" >= 1));

-- The hierarchy evidence, as on `contract_signature`: all of it or none, only the employer's.
ALTER TABLE "amendment_signature" ADD CONSTRAINT "ck_amendment_signature_hierarchy_evidence"
  CHECK (num_nonnulls("hierarchy_author_organization_id", "hierarchy_answer",
                      "hierarchy_read_at", "hierarchy_commit_deadline") IN (0, 4)
         AND ("hierarchy_answer" IS NULL OR "hierarchy_answer" = 'WITHIN')
         AND ("hierarchy_author_organization_id" IS NULL OR btrim("hierarchy_author_organization_id") <> '')
         AND ("hierarchy_read_at" IS NULL OR "hierarchy_commit_deadline" >= "hierarchy_read_at")
         AND ("hierarchy_read_at" IS NULL OR "side" = 'EMPLOYER')
         AND ("hierarchy_version" IS NULL
              OR ("hierarchy_version" >= 1 AND "hierarchy_read_at" IS NOT NULL)));

-- A signature is a record, not state: written once, never changed or removed. The database
-- refuses the ways one could be wrong whatever the code forgets, as `contract_signature_guard`
-- does for the contract: an amendment that is not proposed, a contract that is not SIGNED, a
-- signature for a side by an organization that is not that side, an employer signature under no
-- policy in force that names the signer's role, and one person on both sides.
CREATE FUNCTION "amendment_signature_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
  amended RECORD;
  other RECORD;
  authorised boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "organization_id", "contractor_organization_id", "status" INTO parent
      FROM "contract"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
    IF NOT FOUND OR parent."status" <> 'SIGNED' THEN
      RAISE EXCEPTION 'ck_amendment_signature_contract_signed: only a signed contract''s amendment is signed'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "contract_id", "status" INTO amended FROM "amendment"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."amendment_id";
    IF NOT FOUND OR amended."contract_id" <> NEW."contract_id" OR amended."status" <> 'PROPOSED' THEN
      RAISE EXCEPTION 'ck_amendment_signature_proposed: only a proposed amendment of this contract is signed'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."side" = 'EMPLOYER' AND NEW."signer_organization_id" <> parent."organization_id")
       OR (NEW."side" = 'CONTRACTOR'
           AND NEW."signer_organization_id" <> parent."contractor_organization_id") THEN
      RAISE EXCEPTION 'ck_amendment_signature_side_organization: the signer''s organization is not that side of the contract'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."side" = 'EMPLOYER' THEN
      SELECT EXISTS (
        SELECT 1
          FROM "approval_policy" p
          JOIN "approval_policy_step" s
            ON s."organization_id" = p."organization_id" AND s."policy_id" = p."id"
         WHERE p."organization_id" = NEW."organization_id"
           AND p."id" = NEW."policy_id"
           AND p."workflow_key" = 'contract.signature'
           AND p."status" = 'ACTIVE'
           AND p."policy_version" = NEW."policy_version"
           AND s."authority_organization_id" = parent."organization_id"
           AND s."authority_role" = NEW."authority_role"
      ) INTO authorised;
      IF NOT authorised THEN
        RAISE EXCEPTION 'ck_amendment_signature_policy_authority: the employer signs only under a policy in force that names the signer''s role'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    FOR other IN
      SELECT "signed_by", "signed_by_issuer", "signed_by_subject" FROM "amendment_signature"
       WHERE "organization_id" = NEW."organization_id" AND "amendment_id" = NEW."amendment_id"
         AND "side" <> NEW."side"
    LOOP
      IF other."signed_by" = NEW."signed_by"
         OR other."signed_by" = NEW."signed_by_subject"
         OR NEW."signed_by" = other."signed_by_subject"
         OR (other."signed_by_issuer" IS NOT NULL
             AND other."signed_by_issuer" = NEW."signed_by_issuer"
             AND other."signed_by_subject" = NEW."signed_by_subject") THEN
        RAISE EXCEPTION 'ck_amendment_signature_one_person_one_side: one person cannot sign for both sides'
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_amendment_signature_immutable: an amendment signature is never changed, deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_amendment_signature_insert"
  BEFORE INSERT ON "amendment_signature"
  FOR EACH ROW EXECUTE FUNCTION "amendment_signature_guard"();

CREATE TRIGGER "tg_amendment_signature_immutable"
  BEFORE UPDATE OR DELETE ON "amendment_signature"
  FOR EACH ROW EXECUTE FUNCTION "amendment_signature_guard"();

CREATE TRIGGER "tg_amendment_signature_no_truncate"
  BEFORE TRUNCATE ON "amendment_signature"
  FOR EACH STATEMENT EXECUTE FUNCTION "amendment_signature_guard"();

-- ---- amendment: the lifecycle and the counter, kept by the database -----------

CREATE FUNCTION "amendment_guard"() RETURNS trigger AS $$
DECLARE
  parent_status "ContractStatus";
  sides integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status" INTO parent_status FROM "contract"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
    IF parent_status IS DISTINCT FROM 'SIGNED' THEN
      RAISE EXCEPTION 'ck_amendment_contract_signed: only a signed contract is amended'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'PROPOSED' THEN
      RAISE EXCEPTION 'ck_amendment_born_proposed: an amendment is proposed before it is effective'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'EFFECTIVE' THEN
      RAISE EXCEPTION 'ck_amendment_immutable: an effective amendment never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."contract_id" IS DISTINCT FROM OLD."contract_id"
       OR NEW."amendment_number" IS DISTINCT FROM OLD."amendment_number"
       OR NEW."delta_minor" IS DISTINCT FROM OLD."delta_minor"
       OR NEW."reason_code" IS DISTINCT FROM OLD."reason_code"
       OR NEW."reason_text" IS DISTINCT FROM OLD."reason_text"
       OR NEW."proposed_by" IS DISTINCT FROM OLD."proposed_by"
       OR NEW."proposed_at" IS DISTINCT FROM OLD."proposed_at"
       OR NEW."proposed_correlation_id" IS DISTINCT FROM OLD."proposed_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_amendment_terms_immutable: what an amendment says never changes once proposed'
        USING ERRCODE = 'check_violation';
    END IF;
    -- PROPOSED > EFFECTIVE is the only transition, and only when both sides have signed it
    -- and the contract is still SIGNED (`amendment.state-machine.ts` declares the same table).
    IF NEW."status" = 'EFFECTIVE' THEN
      SELECT "status" INTO parent_status FROM "contract"
       WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
      IF parent_status IS DISTINCT FROM 'SIGNED' THEN
        RAISE EXCEPTION 'ck_amendment_contract_signed: only a signed contract is amended'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(DISTINCT "side") INTO sides FROM "amendment_signature"
       WHERE "organization_id" = NEW."organization_id" AND "amendment_id" = NEW."id";
      IF sides <> 2 THEN
        RAISE EXCEPTION 'ck_amendment_signed_by_both: an amendment is effective only when both sides have signed it'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_amendment_not_erasable: an amendment is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_amendment_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "amendment"
  FOR EACH ROW EXECUTE FUNCTION "amendment_guard"();

CREATE TRIGGER "tg_amendment_no_truncate"
  BEFORE TRUNCATE ON "amendment"
  FOR EACH STATEMENT EXECUTE FUNCTION "amendment_guard"();

-- The counter and the amendments agree, at commit: `contract.amendments_total_minor` is the exact
-- sum of the effective deltas, so an amendment cannot become effective without the contract's
-- total moving in the same transaction, and the total cannot move without one (`contract_guard`
-- refuses that at the statement).
CREATE FUNCTION "amendment_total_consistent"() RETURNS trigger AS $$
DECLARE
  recorded numeric;
  summed numeric;
BEGIN
  SELECT "amendments_total_minor" INTO recorded FROM "contract"
   WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
  SELECT coalesce(sum("delta_minor"), 0) INTO summed FROM "amendment"
   WHERE "organization_id" = NEW."organization_id" AND "contract_id" = NEW."contract_id"
     AND "status" = 'EFFECTIVE';
  IF recorded IS DISTINCT FROM summed THEN
    RAISE EXCEPTION 'ck_amendment_total_consistent: the contract''s amendments total must equal the sum of its effective amendments'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_amendment_total_consistent"
  AFTER INSERT OR UPDATE ON "amendment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "amendment_total_consistent"();

-- ---- amendment_signature_review ----------------------------------------------

-- CreateTable
CREATE TABLE "amendment_signature_review" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "amendment_id" TEXT NOT NULL,
    "side" "ContractSide" NOT NULL,
    "policy_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "cause_event_id" TEXT NOT NULL,
    "moved_at" TIMESTAMPTZ(3) NOT NULL,
    "moved_version" BIGINT,
    "recorded_version" BIGINT,
    "flagged_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "amendment_signature_review_pkey" PRIMARY KEY ("id")
);

-- One review per signature: a second move that strands the same policy again adds nothing.
CREATE UNIQUE INDEX "ux_amendment_signature_review_signature"
    ON "amendment_signature_review"("organization_id", "amendment_id", "side");
CREATE INDEX "ix_amendment_signature_review_policy"
    ON "amendment_signature_review"("organization_id", "policy_id");

ALTER TABLE "amendment_signature_review"
  ADD CONSTRAINT "amendment_signature_review_signature_fkey"
  FOREIGN KEY ("organization_id", "amendment_id", "side")
  REFERENCES "amendment_signature"("organization_id", "amendment_id", "side")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "amendment_signature_review"
  ADD CONSTRAINT "amendment_signature_review_policy_fkey"
  FOREIGN KEY ("organization_id", "policy_id")
  REFERENCES "approval_policy"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "amendment_signature_review" ADD CONSTRAINT "ck_amendment_review_reason"
  CHECK ("reason" = 'AUTHORITY_CHANGED_DURING_SIGNING'
         AND "side" = 'EMPLOYER'
         AND btrim("cause_event_id") <> ''
         AND ("moved_version" IS NULL OR "moved_version" >= 1)
         AND ("recorded_version" IS NULL OR "recorded_version" >= 1));

CREATE FUNCTION "amendment_signature_review_guard"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ck_amendment_review_immutable: an amendment signature review is never changed, deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_amendment_signature_review_immutable"
  BEFORE UPDATE OR DELETE ON "amendment_signature_review"
  FOR EACH ROW EXECUTE FUNCTION "amendment_signature_review_guard"();

CREATE TRIGGER "tg_amendment_signature_review_no_truncate"
  BEFORE TRUNCATE ON "amendment_signature_review"
  FOR EACH STATEMENT EXECUTE FUNCTION "amendment_signature_review_guard"();

-- ---- milestone ---------------------------------------------------------------

-- CreateTable
CREATE TABLE "milestone" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "planned_date" DATE NOT NULL,
    "planned_share_bp" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_correlation_id" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" TEXT NOT NULL,
    "first_referenced_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "milestone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_milestone_org_id" ON "milestone"("organization_id", "id");
CREATE INDEX "ix_milestone_contract" ON "milestone"("organization_id", "contract_id", "planned_date", "id");

-- AddForeignKey
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_organization_id_contract_id_fkey"
  FOREIGN KEY ("organization_id", "contract_id") REFERENCES "contract"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "milestone" ADD CONSTRAINT "ck_milestone_text_not_blank"
  CHECK (btrim("organization_id") <> '' AND btrim("contract_id") <> ''
         AND btrim("created_by") <> '' AND btrim("updated_by") <> ''
         AND btrim("created_correlation_id") <> '');

-- A bounded title without bidirectional control characters; a share is 1 to 10000 basis points
-- when given. No sum across a contract's milestones is kept: no document defines one (Q-100).
ALTER TABLE "milestone" ADD CONSTRAINT "ck_milestone_title"
  CHECK (btrim("title") <> '' AND length("title") <= 200
         AND "title" !~ '[؜‎‏‪-‮⁦-⁩]');

ALTER TABLE "milestone" ADD CONSTRAINT "ck_milestone_share"
  CHECK ("planned_share_bp" IS NULL OR ("planned_share_bp" >= 1 AND "planned_share_bp" <= 10000));

ALTER TABLE "milestone" ADD CONSTRAINT "ck_milestone_version_timestamps"
  CHECK ("version" >= 1 AND "updated_at" >= "created_at"
         AND ("first_referenced_at" IS NULL OR "first_referenced_at" >= "created_at"));

-- A milestone is planned on a SIGNED contract, and while it is not referenced it may be edited,
-- on that contract only. Once a statement refers to it (`first_referenced_at`, set by PR 4) it is
-- frozen for good; it is never deleted, and the day it was made and by whom never change.
CREATE FUNCTION "milestone_guard"() RETURNS trigger AS $$
DECLARE
  parent_status "ContractStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status" INTO parent_status FROM "contract"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
    IF parent_status IS DISTINCT FROM 'SIGNED' THEN
      RAISE EXCEPTION 'ck_milestone_contract_signed: milestones are planned on a signed contract'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."first_referenced_at" IS NOT NULL THEN
      RAISE EXCEPTION 'ck_milestone_born_unreferenced: a new milestone is referenced by nothing'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."contract_id" IS DISTINCT FROM OLD."contract_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_milestone_origin_immutable: what a milestone belongs to never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."first_referenced_at" IS NOT NULL THEN
      RAISE EXCEPTION 'ck_milestone_referenced: a milestone a statement refers to never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "status" INTO parent_status FROM "contract"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
    IF parent_status IS DISTINCT FROM 'SIGNED' THEN
      RAISE EXCEPTION 'ck_milestone_contract_signed: milestones are changed on a signed contract'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_milestone_not_erasable: a milestone is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_milestone_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "milestone"
  FOR EACH ROW EXECUTE FUNCTION "milestone_guard"();

CREATE TRIGGER "tg_milestone_no_truncate"
  BEFORE TRUNCATE ON "milestone"
  FOR EACH STATEMENT EXECUTE FUNCTION "milestone_guard"();

-- ---- contract_guard: the amount counters, kept by the database -----------------

CREATE OR REPLACE FUNCTION "contract_guard"() RETURNS trigger AS $$
DECLARE
  sides integer;
  effective_sum numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."tender_id" IS DISTINCT FROM OLD."tender_id"
       OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
       OR NEW."winning_bid_id" IS DISTINCT FROM OLD."winning_bid_id"
       OR NEW."contractor_organization_id" IS DISTINCT FROM OLD."contractor_organization_id"
       OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
       OR NEW."matrix_digest" IS DISTINCT FROM OLD."matrix_digest"
       OR NEW."awarded_by" IS DISTINCT FROM OLD."awarded_by"
       OR NEW."awarded_at" IS DISTINCT FROM OLD."awarded_at"
       OR NEW."source_event_id" IS DISTINCT FROM OLD."source_event_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_contract_origin_immutable: what a contract was made from never changes'
        USING ERRCODE = 'check_violation';
    END IF;

    -- A cancelled or settled contract is history: nothing about it changes again.
    IF OLD."status" IN ('CANCELLED', 'SETTLED') THEN
      RAISE EXCEPTION 'ck_contract_final: a % contract never changes', OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      IF NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('SIGNED', 'CANCELLED'))
              OR (OLD."status" = 'SIGNED' AND NEW."status" = 'COMPLETED')
              OR (OLD."status" = 'COMPLETED' AND NEW."status" = 'SETTLED')) THEN
        RAISE EXCEPTION 'ck_contract_transition: a contract cannot move from % to %', OLD."status", NEW."status"
          USING ERRCODE = 'check_violation';
      END IF;
      -- Both parties have accepted, or the contract is not signed (Q-95 (1)).
      IF NEW."status" = 'SIGNED' THEN
        SELECT count(DISTINCT "side") INTO sides FROM "contract_signature"
         WHERE "organization_id" = NEW."organization_id" AND "contract_id" = NEW."id";
        IF sides <> 2 THEN
          RAISE EXCEPTION 'ck_contract_signed_by_both: a contract is signed only when both sides have signed'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;

    IF OLD."cancel_reason_code" IS NOT NULL
       AND (NEW."cancel_reason_code" IS DISTINCT FROM OLD."cancel_reason_code"
            OR NEW."cancel_note" IS DISTINCT FROM OLD."cancel_note") THEN
      RAISE EXCEPTION 'ck_contract_cancellation_immutable: the reason a contract was cancelled never changes'
        USING ERRCODE = 'check_violation';
    END IF;

    -- The amount counters (ADR-068 § 5). The amendments total moves only on a contract that is
    -- and stays SIGNED, and only to the exact sum of the effective amendments — so only in the
    -- transaction that made one effective. The approved total is PR 4's: it stays where it is.
    IF NEW."amendments_total_minor" IS DISTINCT FROM OLD."amendments_total_minor" THEN
      IF OLD."status" <> 'SIGNED' OR NEW."status" <> 'SIGNED' THEN
        RAISE EXCEPTION 'ck_contract_amendments_signed: only a signed contract is amended'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT coalesce(sum("delta_minor"), 0) INTO effective_sum FROM "amendment"
       WHERE "organization_id" = NEW."organization_id" AND "contract_id" = NEW."id"
         AND "status" = 'EFFECTIVE';
      IF NEW."amendments_total_minor" <> effective_sum THEN
        RAISE EXCEPTION 'ck_contract_amendments_total_exact: the amendments total is the sum of the effective amendments'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."approved_total_minor" IS DISTINCT FROM OLD."approved_total_minor" THEN
      RAISE EXCEPTION 'ck_contract_approved_total_fixed: the approved total moves with statements, which do not exist yet'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_contract_not_erasable: a contract is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
