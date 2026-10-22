-- =============================================================================
-- procurement-service — issuing an RFQ from a READY aggregation, its frozen
-- criteria and explicit invitations, its sealing key, its close at the deadline
-- and its cancellation (COM-007 PR 6; ADR-070 § 3, § 4, § 10; plan PR 6).
--
-- 1. `rfq`: one per aggregation (`ux_rfq_aggregation`), born PUBLISHED in the
--    transaction that moves its aggregation READY → RFQ_ISSUED — the RFQ names
--    the aggregation (`fk_rfq_aggregation`, its organization and product too), the
--    aggregation names the RFQ (`fk_demand_aggregation_rfq`, this RFQ of this
--    aggregation), and at commit each must name the other (`tg_rfq_issue_check`).
--    The total quantity is the aggregation's, frozen; the procurement nature is
--    required, with no default (ADR-023, Q-03). The deadline is a column, read
--    against the database clock after the RFQ's lock (ADR-065 § 2): the close is
--    refused before it, whatever writes it (`rfq_guard`). The sealing key: the
--    public half in the clear, the private half only wrapped by a KEK of
--    PROCUREMENT_RFQ_KEKS (ADR-066 § 2) — never unwrapped before the opening of
--    plan PR 9. The close sweeper's lease, fence and backoff are bookkeeping:
--    they move no version.
-- 2. `rfq_criterion`: copied into the RFQ by the issue, weights summing to 10000
--    (ADR-067 § 1), and frozen: never changed or erased, and none added later —
--    at commit every RFQ holds exactly the criteria and invitations it states
--    (`criteria_count`, `invitation_count`; `tg_rfq_criterion_count_check`,
--    `tg_rfq_invitation_count_check`), so a row inserted after the issue's
--    transaction is refused.
-- 3. `rfq_invitation`: the explicit invitations (Q-121 (1)), never the buyer
--    itself (`ck_rfq_invitation_not_buyer`). Tenant = the buyer; the invited
--    supplier reads its RFQs by `supplier_organization_id`
--    (`ix_rfq_invitation_supplier`, a read that crosses the tenant guard with a
--    written reason, ADR-070 § 10).
--
-- Statuses are text under a CHECK naming the whole lifecycle, the later PRs'
-- included (ADR-068 § 2). Every instant is TIMESTAMPTZ(3) (D-048). Nothing here
-- is ever deleted or truncated: an audit reads it.
-- =============================================================================

CREATE TABLE "rfq" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "aggregation_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "total_quantity" INTEGER NOT NULL,
    "procurement_nature" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "quotation_closing_at" TIMESTAMPTZ(3) NOT NULL,
    "criteria_count" INTEGER NOT NULL,
    "criteria_digest" TEXT NOT NULL,
    "invitation_count" INTEGER NOT NULL,
    "key_id" TEXT NOT NULL,
    "public_key_pem" TEXT NOT NULL,
    "kek_id" TEXT NOT NULL,
    "wrap_nonce" BYTEA NOT NULL,
    "wrapped_private_key" BYTEA NOT NULL,
    "wrap_tag" BYTEA NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "issued_by" TEXT NOT NULL,
    "issued_correlation_id" TEXT NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" TEXT,
    "cancel_reason_code" TEXT,
    "cancel_reason" TEXT,
    "sweep_lease_until" TIMESTAMPTZ(3),
    "sweep_fence" TEXT,
    "sweep_attempts" INTEGER NOT NULL DEFAULT 0,
    "sweep_next_attempt_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "rfq_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rfq_criterion" (
    "organization_id" TEXT NOT NULL,
    "rfq_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "weight_bp" INTEGER NOT NULL,
    "scoring_method" TEXT NOT NULL,
    "max_score" INTEGER NOT NULL,

    CONSTRAINT "rfq_criterion_pkey" PRIMARY KEY ("organization_id", "rfq_id", "position")
);

CREATE TABLE "rfq_invitation" (
    "organization_id" TEXT NOT NULL,
    "rfq_id" TEXT NOT NULL,
    "supplier_organization_id" TEXT NOT NULL,
    "invited_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rfq_invitation_pkey" PRIMARY KEY ("organization_id", "rfq_id", "supplier_organization_id")
);

CREATE UNIQUE INDEX "ux_rfq_org_id" ON "rfq"("organization_id", "id");
-- One RFQ per aggregation: an RFQ that is cancelled leaves its aggregation RFQ_ISSUED (Q-121 (4)).
CREATE UNIQUE INDEX "ux_rfq_aggregation" ON "rfq"("organization_id", "aggregation_id");
-- The target of the aggregation's reference: this RFQ, of this aggregation.
CREATE UNIQUE INDEX "ux_rfq_org_id_aggregation" ON "rfq"("organization_id", "id", "aggregation_id");
CREATE INDEX "ix_rfq_org_status" ON "rfq"("organization_id", "status", "id");
CREATE UNIQUE INDEX "ux_rfq_key_id" ON "rfq"("key_id");
-- The close sweeper's queue: PUBLISHED RFQs by their deadline, every tenant at once.
CREATE INDEX "ix_rfq_close_due" ON "rfq"("quotation_closing_at", "id") WHERE "status" = 'PUBLISHED';

CREATE UNIQUE INDEX "ux_rfq_criterion_code" ON "rfq_criterion"("organization_id", "rfq_id", "code");
-- The invited supplier's own RFQs (ADR-070 § 10): the supplier is another tenant.
CREATE INDEX "ix_rfq_invitation_supplier" ON "rfq_invitation"("supplier_organization_id", "rfq_id");

-- ---- rfq -------------------------------------------------------------------------

-- An RFQ is of its buyer's aggregation and of the same product.
ALTER TABLE "rfq" ADD CONSTRAINT "fk_rfq_aggregation"
  FOREIGN KEY ("organization_id", "aggregation_id", "product_id")
  REFERENCES "demand_aggregation" ("organization_id", "id", "product_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The aggregation names an RFQ of its own (rfq_id is set exactly on RFQ_ISSUED,
-- ck_demand_aggregation_rfq). Deferrable, so the two rows that name each other can be removed in
-- one transaction by an owner's cleanup; immediate for every write the service makes.
ALTER TABLE "demand_aggregation" ADD CONSTRAINT "fk_demand_aggregation_rfq"
  FOREIGN KEY ("organization_id", "rfq_id", "id")
  REFERENCES "rfq" ("organization_id", "id", "aggregation_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

-- Every status of the lifecycle, the later PRs' included (ADR-070 § 3).
ALTER TABLE "rfq" ADD CONSTRAINT "ck_rfq_status"
  CHECK ("status" IN ('PUBLISHED', 'CLOSED', 'EVALUATING', 'EVALUATED', 'AWARDED', 'CANCELLED'));

ALTER TABLE "rfq" ADD CONSTRAINT "ck_rfq_identifiers"
  CHECK (btrim("id") <> '' AND btrim("organization_id") <> '' AND btrim("aggregation_id") <> ''
         AND "product_id" ~ '^PRD_[0-9A-HJKMNP-TV-Z]{26}$');

-- Required, from the closed set, with no default (ADR-023, Q-03).
ALTER TABLE "rfq" ADD CONSTRAINT "ck_rfq_procurement_nature"
  CHECK ("procurement_nature" IN ('FORMAL_TENDER', 'INQUIRY', 'RFP', 'MARKETPLACE_DEAL'));

-- The aggregation's total, a whole positive quantity no larger than MAX_QUANTITY (ADR-070 § 2).
ALTER TABLE "rfq" ADD CONSTRAINT "ck_rfq_total_quantity"
  CHECK ("total_quantity" BETWEEN 1 AND 2147483647);

-- At least one criterion and one invitation, within their bounds (MAX_CRITERIA, the bound of
-- PROCUREMENT_RFQ_MAX_INVITEES); the criteria named by their digest.
ALTER TABLE "rfq" ADD CONSTRAINT "ck_rfq_contents"
  CHECK ("criteria_count" BETWEEN 1 AND 50 AND "invitation_count" BETWEEN 1 AND 500
         AND "criteria_digest" ~ '^[0-9a-f]{64}$');

-- The sealing key: an SPKI public key, and the private half wrapped (AES-256-GCM, 12-byte nonce,
-- 16-byte tag) under a named KEK.
ALTER TABLE "rfq" ADD CONSTRAINT "ck_rfq_key"
  CHECK (btrim("key_id") <> '' AND "public_key_pem" LIKE '-----BEGIN PUBLIC KEY-----%'
         AND "kek_id" ~ '^[a-z0-9][a-z0-9-]{0,31}$'
         AND octet_length("wrap_nonce") = 12 AND octet_length("wrap_tag") = 16
         AND octet_length("wrapped_private_key") > 0);

-- Who issued it, from which request, and a deadline after the issue.
ALTER TABLE "rfq" ADD CONSTRAINT "ck_rfq_issued"
  CHECK (btrim("issued_by") <> '' AND btrim("issued_correlation_id") <> ''
         AND "quotation_closing_at" > "issued_at" AND "issued_at" >= "created_at");

-- Closed at or after the deadline, exactly on the statuses the close leads to (a CANCELLED RFQ
-- keeps a close it had); by a person, or by the sweeper (no person).
ALTER TABLE "rfq" ADD CONSTRAINT "ck_rfq_closed"
  CHECK (("status" <> 'PUBLISHED' OR "closed_at" IS NULL)
         AND ("status" NOT IN ('CLOSED', 'EVALUATING', 'EVALUATED', 'AWARDED') OR "closed_at" IS NOT NULL)
         AND ("closed_by" IS NULL OR ("closed_at" IS NOT NULL AND btrim("closed_by") <> ''))
         AND ("closed_at" IS NULL OR "closed_at" >= "quotation_closing_at"));

-- A cancellation names when, who, the closed code and why — all four, only on a CANCELLED RFQ.
ALTER TABLE "rfq" ADD CONSTRAINT "ck_rfq_cancelled"
  CHECK ((("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL))
         AND num_nonnulls("cancelled_at", "cancelled_by", "cancel_reason_code", "cancel_reason") IN (0, 4)
         AND ("cancelled_by" IS NULL OR btrim("cancelled_by") <> '')
         AND ("cancel_reason_code" IS NULL OR "cancel_reason_code" IN ('BUYER_REQUEST'))
         AND ("cancel_reason" IS NULL OR char_length(btrim("cancel_reason")) BETWEEN 8 AND 500)
         AND ("cancelled_at" IS NULL OR "cancelled_at" >= "issued_at"));

-- The close sweeper's claim is a lease and its fence together, or neither.
ALTER TABLE "rfq" ADD CONSTRAINT "ck_rfq_sweep_claim"
  CHECK ((("sweep_lease_until" IS NULL) = ("sweep_fence" IS NULL))
         AND ("sweep_fence" IS NULL OR btrim("sweep_fence") <> '')
         AND "sweep_attempts" >= 0);

ALTER TABLE "rfq" ADD CONSTRAINT "ck_rfq_version_positive" CHECK ("version" >= 1);

ALTER TABLE "rfq" ADD CONSTRAINT "ck_rfq_timestamps_ordered" CHECK ("updated_at" >= "created_at");

-- ---- rfq_criterion ---------------------------------------------------------------

ALTER TABLE "rfq_criterion" ADD CONSTRAINT "fk_rfq_criterion_rfq"
  FOREIGN KEY ("organization_id", "rfq_id") REFERENCES "rfq" ("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A criterion is data (ADR-067 § 1): a code, a label, a weight in basis points, one of the scoring
-- methods the code implements, and a whole maximum score — 1 for PASS_FAIL.
ALTER TABLE "rfq_criterion" ADD CONSTRAINT "ck_rfq_criterion_values"
  CHECK ("position" BETWEEN 1 AND 50
         AND "code" ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$'
         AND char_length(btrim("label")) BETWEEN 1 AND 200
         AND "weight_bp" BETWEEN 1 AND 10000
         AND "scoring_method" IN ('MANUAL_SCORE', 'PASS_FAIL')
         AND "max_score" BETWEEN 1 AND 1000000
         AND ("scoring_method" <> 'PASS_FAIL' OR "max_score" = 1));

-- ---- rfq_invitation --------------------------------------------------------------

ALTER TABLE "rfq_invitation" ADD CONSTRAINT "fk_rfq_invitation_rfq"
  FOREIGN KEY ("organization_id", "rfq_id") REFERENCES "rfq" ("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The buyer never invites itself (ADR-070 § 3).
ALTER TABLE "rfq_invitation" ADD CONSTRAINT "ck_rfq_invitation_not_buyer"
  CHECK ("supplier_organization_id" <> "organization_id"
         AND btrim("supplier_organization_id") <> '' AND btrim("rfq_id") <> '');

-- =============================================================================
-- The lifecycle and the freeze the database keeps (ADR-063 § 1)
-- =============================================================================
--
-- The code moves an RFQ by a compare-and-set against `src/rfq/rfq.state-machine.ts`; these guards
-- refuse what that table does not have, even from a future write path that forgets it. The runtime
-- role owns nothing and cannot disable them (D-045).

-- An RFQ is born PUBLISHED, version 1, with nothing of a close, a cancellation or a sweep, from its
-- buyer's READY aggregation whose end is recorded (its digest written: nothing moves a window on
-- before its end's event, PR 2), with that aggregation's total, after it ended.
CREATE FUNCTION "rfq_born_guard"() RETURNS trigger AS $$
DECLARE
  aggregation RECORD;
BEGIN
  IF NEW."status" <> 'PUBLISHED' OR NEW."version" <> 1
     OR NEW."closed_at" IS NOT NULL OR NEW."closed_by" IS NOT NULL
     OR num_nonnulls(NEW."cancelled_at", NEW."cancelled_by", NEW."cancel_reason_code", NEW."cancel_reason") <> 0
     OR NEW."sweep_lease_until" IS NOT NULL OR NEW."sweep_fence" IS NOT NULL
     OR NEW."sweep_attempts" <> 0 OR NEW."sweep_next_attempt_at" IS NOT NULL
  THEN
    RAISE EXCEPTION 'ck_rfq_born_published: an RFQ is issued PUBLISHED, version 1, with no close, cancellation or sweep'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "status", "total_quantity", "demand_ids_sha256", "closed_at" INTO aggregation
    FROM "demand_aggregation"
   WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."aggregation_id";
  IF aggregation."status" IS DISTINCT FROM 'READY' OR aggregation."demand_ids_sha256" IS NULL THEN
    RAISE EXCEPTION 'ck_rfq_from_ready_aggregation: an RFQ is issued from a READY aggregation whose end is recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."total_quantity" <> aggregation."total_quantity" OR NEW."issued_at" < aggregation."closed_at" THEN
    RAISE EXCEPTION 'ck_rfq_from_ready_aggregation: an RFQ states its aggregation''s total, after its window ended'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_rfq_born"
  BEFORE INSERT ON "rfq"
  FOR EACH ROW EXECUTE FUNCTION "rfq_born_guard"();

-- After the issue: the lifecycle's transitions only; what the RFQ was issued with never changes; the
-- close only at or after the deadline and only by PUBLISHED → CLOSED; the cancellation only by a
-- move to CANCELLED; every change one version more. The close sweeper's bookkeeping alone moves no
-- version.
CREATE FUNCTION "rfq_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['sweep_lease_until', 'sweep_fence', 'sweep_attempts', 'sweep_next_attempt_at'])
       = (to_jsonb(OLD) - ARRAY['sweep_lease_until', 'sweep_fence', 'sweep_attempts', 'sweep_next_attempt_at'])
    THEN
      RETURN NEW;
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."aggregation_id" IS DISTINCT FROM OLD."aggregation_id"
       OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
       OR NEW."total_quantity" IS DISTINCT FROM OLD."total_quantity"
       OR NEW."procurement_nature" IS DISTINCT FROM OLD."procurement_nature"
       OR NEW."quotation_closing_at" IS DISTINCT FROM OLD."quotation_closing_at"
       OR NEW."criteria_count" IS DISTINCT FROM OLD."criteria_count"
       OR NEW."criteria_digest" IS DISTINCT FROM OLD."criteria_digest"
       OR NEW."invitation_count" IS DISTINCT FROM OLD."invitation_count"
       OR NEW."key_id" IS DISTINCT FROM OLD."key_id"
       OR NEW."public_key_pem" IS DISTINCT FROM OLD."public_key_pem"
       OR NEW."kek_id" IS DISTINCT FROM OLD."kek_id"
       OR NEW."wrap_nonce" IS DISTINCT FROM OLD."wrap_nonce"
       OR NEW."wrapped_private_key" IS DISTINCT FROM OLD."wrapped_private_key"
       OR NEW."wrap_tag" IS DISTINCT FROM OLD."wrap_tag"
       OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
       OR NEW."issued_by" IS DISTINCT FROM OLD."issued_by"
       OR NEW."issued_correlation_id" IS DISTINCT FROM OLD."issued_correlation_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'ck_rfq_origin_immutable: what an RFQ was issued with never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = OLD."status" OR NOT (
         (OLD."status" = 'PUBLISHED' AND NEW."status" IN ('CLOSED', 'CANCELLED'))
      OR (OLD."status" = 'CLOSED' AND NEW."status" IN ('EVALUATING', 'CANCELLED'))
      OR (OLD."status" = 'EVALUATING' AND NEW."status" IN ('EVALUATED', 'CANCELLED'))
      OR (OLD."status" = 'EVALUATED' AND NEW."status" IN ('AWARDED', 'CANCELLED'))
    ) THEN
      RAISE EXCEPTION 'ck_rfq_transition: % -> % is not a transition', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."closed_at" IS DISTINCT FROM OLD."closed_at" OR NEW."closed_by" IS DISTINCT FROM OLD."closed_by")
       AND NOT (OLD."status" = 'PUBLISHED' AND NEW."status" = 'CLOSED')
    THEN
      RAISE EXCEPTION 'ck_rfq_closed: a close is written only by PUBLISHED -> CLOSED'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'PUBLISHED' AND NEW."status" = 'CLOSED'
       AND (NEW."closed_at" IS NULL OR NEW."closed_at" < NEW."quotation_closing_at")
    THEN
      RAISE EXCEPTION 'ck_rfq_deadline: an RFQ is closed only at or after its quotation deadline'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
        OR NEW."cancelled_by" IS DISTINCT FROM OLD."cancelled_by"
        OR NEW."cancel_reason_code" IS DISTINCT FROM OLD."cancel_reason_code"
        OR NEW."cancel_reason" IS DISTINCT FROM OLD."cancel_reason")
       AND NEW."status" <> 'CANCELLED'
    THEN
      RAISE EXCEPTION 'ck_rfq_cancelled: a cancellation is written only by a move to CANCELLED'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'ck_rfq_version: every change moves the version by one'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_rfq_not_erasable: an RFQ is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_rfq_guard"
  BEFORE UPDATE OR DELETE ON "rfq"
  FOR EACH ROW EXECUTE FUNCTION "rfq_guard"();

CREATE TRIGGER "tg_rfq_no_truncate"
  BEFORE TRUNCATE ON "rfq"
  FOR EACH STATEMENT EXECUTE FUNCTION "rfq_guard"();

-- The criteria and invitations an RFQ was issued with: added only while it is PUBLISHED at version
-- 1, and never changed or erased. That they are added only by the issue itself is the count check
-- below: at commit the RFQ holds exactly as many as it states.
CREATE FUNCTION "rfq_child_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM "rfq"
                    WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."rfq_id"
                      AND "status" = 'PUBLISHED' AND "version" = 1) THEN
      RAISE EXCEPTION 'ck_rfq_frozen: % rows are written by the issue of their RFQ, and only then', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_rfq_frozen: % rows are never changed or erased (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_rfq_criterion_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "rfq_criterion"
  FOR EACH ROW EXECUTE FUNCTION "rfq_child_guard"();

CREATE TRIGGER "tg_rfq_criterion_no_truncate"
  BEFORE TRUNCATE ON "rfq_criterion"
  FOR EACH STATEMENT EXECUTE FUNCTION "rfq_child_guard"();

CREATE TRIGGER "tg_rfq_invitation_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "rfq_invitation"
  FOR EACH ROW EXECUTE FUNCTION "rfq_child_guard"();

CREATE TRIGGER "tg_rfq_invitation_no_truncate"
  BEFORE TRUNCATE ON "rfq_invitation"
  FOR EACH STATEMENT EXECUTE FUNCTION "rfq_child_guard"();

-- At commit, an RFQ is what its issue said, whole: its aggregation RFQ_ISSUED and naming it, exactly
-- `criteria_count` criteria weighing 10000 basis points together, exactly `invitation_count`
-- invitations. Deferred, so the rows of one issue may come in any order; run for the RFQ and for
-- each criterion or invitation inserted, so one added by a later transaction — the RFQ already
-- holding its stated count — is refused there.
CREATE FUNCTION "rfq_issue_check"() RETURNS trigger AS $$
DECLARE
  target_id TEXT;
  issued RECORD;
  named TEXT;
  aggregation_status TEXT;
  criteria INTEGER;
  weights BIGINT;
  invitations INTEGER;
BEGIN
  -- Each assignment is prepared only when it runs: NEW has no rfq_id on rfq, no id on the others.
  IF TG_TABLE_NAME = 'rfq' THEN
    target_id := NEW."id";
  ELSE
    target_id := NEW."rfq_id";
  END IF;
  SELECT "id", "organization_id", "aggregation_id", "criteria_count", "invitation_count" INTO issued
    FROM "rfq" WHERE "organization_id" = NEW."organization_id" AND "id" = target_id;
  IF TG_TABLE_NAME = 'rfq' THEN
    SELECT "status", "rfq_id" INTO aggregation_status, named
      FROM "demand_aggregation"
     WHERE "organization_id" = issued."organization_id" AND "id" = issued."aggregation_id";
    IF aggregation_status IS DISTINCT FROM 'RFQ_ISSUED' OR named IS DISTINCT FROM issued."id" THEN
      RAISE EXCEPTION 'ck_rfq_issue_atomic: an RFQ is issued with its aggregation''s READY -> RFQ_ISSUED'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_TABLE_NAME IN ('rfq', 'rfq_criterion') THEN
    SELECT count(*), coalesce(sum("weight_bp"), 0) INTO criteria, weights
      FROM "rfq_criterion"
     WHERE "organization_id" = issued."organization_id" AND "rfq_id" = issued."id";
    IF criteria <> issued."criteria_count" OR weights <> 10000 THEN
      RAISE EXCEPTION 'ck_rfq_criteria_frozen: an RFQ holds the criteria it was issued with, weighing 10000 together'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_TABLE_NAME IN ('rfq', 'rfq_invitation') THEN
    SELECT count(*) INTO invitations
      FROM "rfq_invitation"
     WHERE "organization_id" = issued."organization_id" AND "rfq_id" = issued."id";
    IF invitations <> issued."invitation_count" THEN
      RAISE EXCEPTION 'ck_rfq_invitations_frozen: an RFQ holds the invitations it was issued with'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_rfq_issue_check"
  AFTER INSERT ON "rfq"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "rfq_issue_check"();

CREATE CONSTRAINT TRIGGER "tg_rfq_criterion_count_check"
  AFTER INSERT ON "rfq_criterion"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "rfq_issue_check"();

CREATE CONSTRAINT TRIGGER "tg_rfq_invitation_count_check"
  AFTER INSERT ON "rfq_invitation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "rfq_issue_check"();
