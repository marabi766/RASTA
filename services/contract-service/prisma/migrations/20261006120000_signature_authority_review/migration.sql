-- =============================================================================
-- contract-service — a signature carries the hierarchy evidence it rested on, and a move that
-- raced it flags it for review (CON-003 PR 2 review round 3, ruling 1; docs/23 D-050).
--
-- Signing asks organization-service whether the policy's author still governs the employer, and
-- records the signature in its own database. No local lock can serialise the two services, so a
-- move that lands between the answer and the commit can leave a signature recorded on authority
-- that has just gone. The window cannot be closed; it is made visible:
--
--   * every employer signature under a union-written policy records the evidence it rested on —
--     the author organization asked about, the answer (WITHIN: anything else refused the
--     signature), when the answer arrived, and the latest instant the signature could have
--     committed (the signing transaction's own deadline). organization-service answers `{ id }`
--     and nothing about the employer's parent or a version, so there is none to record;
--   * when an ORGANIZATION_MOVED is reconciled and strands a policy, every signature under it
--     whose answer predates the move and whose commit could have followed it is FLAGGED — a row
--     in `signature_authority_review` and an audit event — never revoked, never cancelled;
--   * the review is its own append-only table, so a signature stays immutable.
--
-- `policy_reconciliation_task.moved_at` is when the move took effect (the event's own instant),
-- what the flagging compares with. NULL on a task queued before this migration: its creation
-- instant stands in for it.
--
-- Every instant is TIMESTAMPTZ(3) (D-048).
-- =============================================================================

ALTER TABLE "policy_reconciliation_task" ADD COLUMN "moved_at" TIMESTAMPTZ(3);

ALTER TABLE "contract_signature"
  ADD COLUMN "hierarchy_author_organization_id" TEXT,
  ADD COLUMN "hierarchy_answer" TEXT,
  ADD COLUMN "hierarchy_read_at" TIMESTAMPTZ(3),
  ADD COLUMN "hierarchy_commit_deadline" TIMESTAMPTZ(3);

-- All of the evidence or none of it; only the employer's side has any; the only answer a
-- signature can rest on is "within" (the others refuse it); the deadline is not before the read.
ALTER TABLE "contract_signature" ADD CONSTRAINT "ck_signature_hierarchy_evidence"
  CHECK (num_nonnulls("hierarchy_author_organization_id", "hierarchy_answer",
                      "hierarchy_read_at", "hierarchy_commit_deadline") IN (0, 4)
         AND ("hierarchy_answer" IS NULL OR "hierarchy_answer" = 'WITHIN')
         AND ("hierarchy_author_organization_id" IS NULL OR btrim("hierarchy_author_organization_id") <> '')
         AND ("hierarchy_read_at" IS NULL OR "hierarchy_commit_deadline" >= "hierarchy_read_at")
         AND ("hierarchy_read_at" IS NULL OR "side" = 'EMPLOYER'));

-- CreateTable
CREATE TABLE "signature_authority_review" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "side" "ContractSide" NOT NULL,
    "policy_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "cause_event_id" TEXT NOT NULL,
    "moved_at" TIMESTAMPTZ(3) NOT NULL,
    "flagged_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "signature_authority_review_pkey" PRIMARY KEY ("id")
);

-- One review per signature: a second move that strands the same policy again adds nothing.
CREATE UNIQUE INDEX "ux_signature_authority_review_signature"
    ON "signature_authority_review"("organization_id", "contract_id", "side");

ALTER TABLE "signature_authority_review"
  ADD CONSTRAINT "signature_authority_review_signature_fkey"
  FOREIGN KEY ("organization_id", "contract_id", "side")
  REFERENCES "contract_signature"("organization_id", "contract_id", "side")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "signature_authority_review"
  ADD CONSTRAINT "signature_authority_review_policy_fkey"
  FOREIGN KEY ("organization_id", "policy_id")
  REFERENCES "approval_policy"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "signature_authority_review" ADD CONSTRAINT "ck_review_reason"
  CHECK ("reason" = 'AUTHORITY_CHANGED_DURING_SIGNING'
         AND "side" = 'EMPLOYER'
         AND btrim("cause_event_id") <> '');

-- A review is a record of what was found: written once, never changed or removed.
CREATE FUNCTION "signature_authority_review_guard"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ck_review_immutable: a signature authority review is never changed, deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_signature_authority_review_immutable"
  BEFORE UPDATE OR DELETE ON "signature_authority_review"
  FOR EACH ROW EXECUTE FUNCTION "signature_authority_review_guard"();

CREATE TRIGGER "tg_signature_authority_review_no_truncate"
  BEFORE TRUNCATE ON "signature_authority_review"
  FOR EACH STATEMENT EXECUTE FUNCTION "signature_authority_review_guard"();
