-- =============================================================================
-- contract-service — who signs for the employer is a policy, not a setting
-- (CON-003 PR 2 review round 1; ADR-068 § 5, Q-95 (1), ADR-063, ADR-023).
--
-- `approval_policy` and `approval_policy_step` are configuration as data, in the shape
-- construction-service keeps them: a policy is written for one organization and one workflow
-- (`contract.signature` is the only one so far), put in force by a platform administrator who is
-- not its author or submitter, and never edited — a change is a new version that retires the old
-- one. An employer with no policy in force has nobody who may sign for it (422): the platform
-- never defaults to granting that authority.
--
-- Every signature of the employer's side records which policy authorised it (id and version),
-- and the database refuses an employer signature that is not under an ACTIVE policy naming the
-- signer's role for that organization.
--
-- Every instant is TIMESTAMPTZ(3) (D-048).
-- =============================================================================

-- CreateEnum
CREATE TYPE "ApprovalPolicyStatus" AS ENUM ('DRAFT', 'PENDING_PLATFORM_APPROVAL', 'ACTIVE', 'REJECTED', 'RETIRED');

-- CreateTable
CREATE TABLE "approval_policy" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "author_organization_id" TEXT NOT NULL,
    "author_role" TEXT NOT NULL,
    "workflow_key" TEXT NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "status" "ApprovalPolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "label" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "is_sample" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_by_issuer" TEXT,
    "created_by_subject" TEXT,
    "created_correlation_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "submitted_by" TEXT,
    "submitted_by_issuer" TEXT,
    "submitted_by_subject" TEXT,
    "activated_at" TIMESTAMPTZ(3),
    "activated_by" TEXT,
    "rejected_at" TIMESTAMPTZ(3),
    "rejected_by" TEXT,
    "rejection_reason" TEXT,
    "retired_at" TIMESTAMPTZ(3),
    "retired_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "approval_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_policy_step" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "authority_organization_id" TEXT NOT NULL,
    "authority_role" TEXT NOT NULL,
    "authority_label" TEXT NOT NULL,

    CONSTRAINT "approval_policy_step_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_approval_policy_org_id" ON "approval_policy"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_approval_policy_version" ON "approval_policy"("organization_id", "workflow_key", "policy_version");

-- CreateIndex
CREATE INDEX "ix_approval_policy_org_key_status" ON "approval_policy"("organization_id", "workflow_key", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_approval_policy_step_order" ON "approval_policy_step"("organization_id", "policy_id", "step_order");

-- CreateIndex
CREATE UNIQUE INDEX "ux_approval_policy_step_authority" ON "approval_policy_step"("organization_id", "policy_id", "authority_organization_id", "authority_role");

-- AddForeignKey
ALTER TABLE "approval_policy_step" ADD CONSTRAINT "approval_policy_step_organization_id_policy_id_fkey"
  FOREIGN KEY ("organization_id", "policy_id") REFERENCES "approval_policy"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---- approval_policy ----------------------------------------------------------

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_text_not_blank"
  CHECK (btrim("workflow_key") <> '' AND btrim("label") <> '' AND btrim("rationale") <> ''
         AND btrim("created_by") <> '' AND btrim("created_correlation_id") <> ''
         AND btrim("author_organization_id") <> '' AND btrim("organization_id") <> '');

-- ADR-063 / Q-70 (7): a union administrator (for its own organization or one beneath it) or the
-- platform administrator writes a policy; an organization administrator never writes its own.
ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_author_role"
  CHECK ("author_role" IN ('UNION_ADMIN', 'SYSTEM_ADMIN'));

-- The workflows a policy may govern. One so far; the technical and financial statement
-- chains (ADR-068 § 5) widen this list in their own migration.
ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_workflow_key"
  CHECK ("workflow_key" IN ('contract.signature'));

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_versions_positive"
  CHECK ("policy_version" >= 1 AND "version" >= 1);

-- The author's and the submitter's stable identity (#188), both halves or neither: what the
-- four-eyes check compares. NULL is "unknown", which that check refuses (fail closed).
ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_identity"
  CHECK (("created_by_issuer" IS NULL) = ("created_by_subject" IS NULL)
         AND ("submitted_by_issuer" IS NULL) = ("submitted_by_subject" IS NULL)
         AND ("created_by_issuer" IS NULL
              OR (btrim("created_by_issuer") <> '' AND btrim("created_by_subject") <> ''))
         AND ("submitted_by_issuer" IS NULL
              OR (btrim("submitted_by_issuer") <> '' AND btrim("submitted_by_subject") <> '')));

-- DRAFT → PENDING_PLATFORM_APPROVAL → ACTIVE (a platform administrator approved it) or REJECTED
-- (with a reason); ACTIVE → RETIRED. Each step names who and when, exactly when the policy has
-- taken it, so a policy can never be ACTIVE without a recorded platform approval.
ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_submission_complete"
  CHECK (num_nonnulls("submitted_at", "submitted_by") IN (0, 2)
         AND (("status" = 'DRAFT') = ("submitted_at" IS NULL)));

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_activation_complete"
  CHECK (num_nonnulls("activated_at", "activated_by") IN (0, 2)
         AND (("status" IN ('ACTIVE', 'RETIRED')) = ("activated_at" IS NOT NULL))
         AND ("activated_at" IS NULL OR "activated_at" >= "submitted_at"));

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_rejection_complete"
  CHECK (num_nonnulls("rejected_at", "rejected_by", "rejection_reason") IN (0, 3)
         AND (("status" = 'REJECTED') = ("rejected_at" IS NOT NULL))
         AND ("rejection_reason" IS NULL OR btrim("rejection_reason") <> '')
         AND ("rejected_at" IS NULL OR "rejected_at" >= "submitted_at"));

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_retirement_complete"
  CHECK (num_nonnulls("retired_at", "retired_by") IN (0, 2)
         AND (("status" = 'RETIRED') = ("retired_at" IS NOT NULL))
         AND ("retired_at" IS NULL OR "retired_at" >= "activated_at"));

-- At most one policy in force per (organization, workflow key).
CREATE UNIQUE INDEX "ux_approval_policy_active"
    ON "approval_policy" ("organization_id", "workflow_key")
 WHERE "status" = 'ACTIVE';

-- ---- approval_policy_step -----------------------------------------------------

ALTER TABLE "approval_policy_step" ADD CONSTRAINT "ck_step_order_positive"
  CHECK ("step_order" >= 1);

ALTER TABLE "approval_policy_step" ADD CONSTRAINT "ck_step_text_not_blank"
  CHECK (btrim("authority_organization_id") <> '' AND btrim("authority_role") <> ''
         AND btrim("authority_label") <> '');

-- The oversight role has aggregate access only, and the platform operator never accepts a
-- contract for a party: neither can be an authority.
ALTER TABLE "approval_policy_step" ADD CONSTRAINT "ck_step_authority_not_oversight"
  CHECK ("authority_role" NOT IN ('AUDITOR', 'SYSTEM_ADMIN'));

-- ---- a policy is written once and never edited ---------------------------------
--
-- What may change is its lifecycle: status, version and the who/when of each step it takes, and
-- only along the declared transitions. Its words (organization, author, workflow, version,
-- label, rationale, steps) and its record (who wrote and submitted it) never change, and a
-- policy is never deleted or truncated — an audit reads it. The runtime role owns nothing and
-- cannot disable this (D-045).
--
--   transitions: DRAFT>PENDING_PLATFORM_APPROVAL PENDING_PLATFORM_APPROVAL>ACTIVE PENDING_PLATFORM_APPROVAL>REJECTED ACTIVE>RETIRED

CREATE FUNCTION "approval_policy_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."author_organization_id" IS DISTINCT FROM OLD."author_organization_id"
       OR NEW."author_role" IS DISTINCT FROM OLD."author_role"
       OR NEW."workflow_key" IS DISTINCT FROM OLD."workflow_key"
       OR NEW."policy_version" IS DISTINCT FROM OLD."policy_version"
       OR NEW."label" IS DISTINCT FROM OLD."label"
       OR NEW."rationale" IS DISTINCT FROM OLD."rationale"
       OR NEW."is_sample" IS DISTINCT FROM OLD."is_sample"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_by_issuer" IS DISTINCT FROM OLD."created_by_issuer"
       OR NEW."created_by_subject" IS DISTINCT FROM OLD."created_by_subject"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_policy_immutable: a policy is written once; a change is a new version'
        USING ERRCODE = 'check_violation';
    END IF;
    -- A step already taken is not rewritten.
    IF (OLD."submitted_at" IS NOT NULL
        AND (NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
             OR NEW."submitted_by" IS DISTINCT FROM OLD."submitted_by"
             OR NEW."submitted_by_issuer" IS DISTINCT FROM OLD."submitted_by_issuer"
             OR NEW."submitted_by_subject" IS DISTINCT FROM OLD."submitted_by_subject"))
       OR (OLD."activated_at" IS NOT NULL
           AND (NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
                OR NEW."activated_by" IS DISTINCT FROM OLD."activated_by"))
       OR (OLD."rejected_at" IS NOT NULL
           AND (NEW."rejected_at" IS DISTINCT FROM OLD."rejected_at"
                OR NEW."rejected_by" IS DISTINCT FROM OLD."rejected_by"
                OR NEW."rejection_reason" IS DISTINCT FROM OLD."rejection_reason"))
       OR (OLD."retired_at" IS NOT NULL
           AND (NEW."retired_at" IS DISTINCT FROM OLD."retired_at"
                OR NEW."retired_by" IS DISTINCT FROM OLD."retired_by"))
    THEN
      RAISE EXCEPTION 'ck_policy_history_immutable: who took a step, and when, is never rewritten'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'PENDING_PLATFORM_APPROVAL')
                OR (OLD."status" = 'PENDING_PLATFORM_APPROVAL' AND NEW."status" IN ('ACTIVE', 'REJECTED'))
                OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRED')) THEN
      RAISE EXCEPTION 'ck_policy_transition: a policy cannot move from % to %', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_policy_not_erasable: a policy is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_approval_policy_guard"
  BEFORE UPDATE OR DELETE ON "approval_policy"
  FOR EACH ROW EXECUTE FUNCTION "approval_policy_guard"();

CREATE TRIGGER "tg_approval_policy_no_truncate"
  BEFORE TRUNCATE ON "approval_policy"
  FOR EACH STATEMENT EXECUTE FUNCTION "approval_policy_guard"();

-- A step is part of the policy it belongs to: written with it, while it is a draft, and never
-- changed or removed.
CREATE FUNCTION "approval_policy_step_guard"() RETURNS trigger AS $$
DECLARE
  parent_status "ApprovalPolicyStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status" INTO parent_status FROM "approval_policy"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."policy_id";
    IF parent_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'ck_step_policy_draft: steps are written with a draft policy only'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_step_immutable: a policy step is never changed, deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_approval_policy_step_insert"
  BEFORE INSERT ON "approval_policy_step"
  FOR EACH ROW EXECUTE FUNCTION "approval_policy_step_guard"();

CREATE TRIGGER "tg_approval_policy_step_immutable"
  BEFORE UPDATE OR DELETE ON "approval_policy_step"
  FOR EACH ROW EXECUTE FUNCTION "approval_policy_step_guard"();

CREATE TRIGGER "tg_approval_policy_step_no_truncate"
  BEFORE TRUNCATE ON "approval_policy_step"
  FOR EACH STATEMENT EXECUTE FUNCTION "approval_policy_step_guard"();

-- ---- contract_signature: the policy that authorised it -------------------------

ALTER TABLE "contract_signature"
  ADD COLUMN "policy_id" TEXT,
  ADD COLUMN "policy_version" INTEGER;

ALTER TABLE "contract_signature" ADD CONSTRAINT "contract_signature_organization_id_policy_id_fkey"
  FOREIGN KEY ("organization_id", "policy_id") REFERENCES "approval_policy"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The employer's side is authorised by a policy and names it; the contractor's is the
-- CONTRACTOR role of its own organization and has none.
ALTER TABLE "contract_signature" ADD CONSTRAINT "ck_signature_policy"
  CHECK (("side" = 'EMPLOYER') = ("policy_id" IS NOT NULL)
         AND ("policy_id" IS NULL) = ("policy_version" IS NULL)
         AND ("policy_version" IS NULL OR "policy_version" >= 1));

-- The signature guard now also judges the authority of the employer's side: the policy exists,
-- governs this organization's `contract.signature`, is in force at the moment of signing, is the
-- version recorded, and names the signer's role for the employer's own organization.
CREATE OR REPLACE FUNCTION "contract_signature_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
  other RECORD;
  authorised boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "organization_id", "contractor_organization_id", "status" INTO parent
      FROM "contract"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
    IF NOT FOUND OR parent."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'ck_signature_contract_draft: only a draft contract is signed'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."side" = 'EMPLOYER' AND NEW."signer_organization_id" <> parent."organization_id")
       OR (NEW."side" = 'CONTRACTOR'
           AND NEW."signer_organization_id" <> parent."contractor_organization_id") THEN
      RAISE EXCEPTION 'ck_signature_side_organization: the signer''s organization is not that side of the contract'
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
        RAISE EXCEPTION 'ck_signature_policy_authority: the employer signs only under a policy in force that names the signer''s role'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    FOR other IN
      SELECT "signed_by", "signed_by_issuer", "signed_by_subject" FROM "contract_signature"
       WHERE "organization_id" = NEW."organization_id" AND "contract_id" = NEW."contract_id"
         AND "side" <> NEW."side"
    LOOP
      IF other."signed_by" = NEW."signed_by"
         OR other."signed_by" = NEW."signed_by_subject"
         OR NEW."signed_by" = other."signed_by_subject"
         OR (other."signed_by_issuer" IS NOT NULL
             AND other."signed_by_issuer" = NEW."signed_by_issuer"
             AND other."signed_by_subject" = NEW."signed_by_subject") THEN
        RAISE EXCEPTION 'ck_signature_one_person_one_side: one person cannot sign for both sides'
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_signature_immutable: a signature is never changed, deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
