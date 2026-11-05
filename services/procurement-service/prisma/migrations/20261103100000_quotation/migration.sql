-- =============================================================================
-- procurement-service — sealed quotations on an issued RFQ and their receipt
-- chain (COM-007 PR 8; ADR-070 § 4, ADR-066 § 2-3; plan PR 8).
--
-- 1. `quotation`: one per invited supplier and RFQ (`ux_quotation_rfq_supplier`),
--    stored under the buyer's organization and naming the supplier's invitation
--    (`fk_quotation_invitation`): no invitation, no quotation. The content is
--    only ever stored sealed (AES-256-GCM under a content key wrapped by the
--    RFQ's public key) with its salted commitment and the digest of the sealed
--    bytes. A submission, a revision (the next revision, a new seal) and a
--    withdrawal are judged on the database's own clock, read now: the RFQ must
--    be PUBLISHED and the clock before `quotation_closing_at` — the half-open
--    deadline the service judges after the RFQ's lock (`ck_quotation_window`).
--    The sealed bytes change only with a new revision; a withdrawn quotation
--    never changes again; nothing is deleted.
-- 2. `quotation_receipt`: the RFQ's receipt chain, append-only, one link per
--    sealed revision, in order (`seq`, at most 10000 — what audit-service
--    returns of a chain): the first link continues the genesis the label
--    `rasta.quotation.receipt.genesis.v1` makes (the bytes audit-service
--    recomputes), every other one the link before it, and no link has two
--    successors (the genesis recomputed in the guard). Each link records when supplier-service last confirmed the
--    supplier's standing (`eligible_as_of`). Not what an opening trusts — that
--    is audit-service's copy (ADR-066 § 2) — but a chain that cannot be
--    written inconsistently by this service.
-- 3. At commit, a quotation's current revision has its link, with the same
--    commitment, digest and instant (`tg_quotation_receipt_check`).
--
-- Every instant is TIMESTAMPTZ(3) (D-048). Statuses are text under a CHECK (ADR-068 § 2);
-- the opening (plan PR 9) adds its own.
-- =============================================================================

CREATE TABLE "quotation" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "rfq_id" TEXT NOT NULL,
    "supplier_organization_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "seal_version" INTEGER NOT NULL,
    "key_id" TEXT NOT NULL,
    "nonce" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "wrapped_content_key" BYTEA NOT NULL,
    "content_commitment" TEXT NOT NULL,
    "ciphertext_sha256" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "submitted_by" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "withdrawn_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "quotation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "quotation_receipt" (
    "organization_id" TEXT NOT NULL,
    "rfq_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "quotation_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "ciphertext_sha256" TEXT NOT NULL,
    "content_commitment" TEXT NOT NULL,
    "previous_receipt" TEXT NOT NULL,
    "receipt" TEXT NOT NULL,
    "eligible_as_of" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotation_receipt_pkey" PRIMARY KEY ("organization_id", "rfq_id", "seq")
);

CREATE UNIQUE INDEX "ux_quotation_org_id" ON "quotation"("organization_id", "id");
CREATE UNIQUE INDEX "ux_quotation_org_rfq_id" ON "quotation"("organization_id", "rfq_id", "id");
-- One quotation per invited supplier and RFQ; also the supplier's own lookup, by the buyer its
-- invitation names.
CREATE UNIQUE INDEX "ux_quotation_rfq_supplier" ON "quotation"("organization_id", "rfq_id", "supplier_organization_id");
-- The quotations standing on an RFQ (the close counts them).
CREATE INDEX "ix_quotation_org_rfq_status" ON "quotation"("organization_id", "rfq_id", "status");

-- No two links of one chain share a receipt or a predecessor (a fork), and a revision has one link.
CREATE UNIQUE INDEX "ux_quotation_receipt_receipt" ON "quotation_receipt"("organization_id", "rfq_id", "receipt");
CREATE UNIQUE INDEX "ux_quotation_receipt_previous" ON "quotation_receipt"("organization_id", "rfq_id", "previous_receipt");
CREATE UNIQUE INDEX "ux_quotation_receipt_revision" ON "quotation_receipt"("organization_id", "quotation_id", "revision");

-- ---- quotation ---------------------------------------------------------------------

-- Only an invited supplier quotes (Q-121 (1)); the invitation names the RFQ and the buyer.
ALTER TABLE "quotation" ADD CONSTRAINT "fk_quotation_invitation"
  FOREIGN KEY ("organization_id", "rfq_id", "supplier_organization_id")
  REFERENCES "rfq_invitation" ("organization_id", "rfq_id", "supplier_organization_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "quotation" ADD CONSTRAINT "ck_quotation_status"
  CHECK ("status" IN ('SUBMITTED', 'WITHDRAWN'));

ALTER TABLE "quotation" ADD CONSTRAINT "ck_quotation_identifiers"
  CHECK ("id" ~ '^QOT_[0-9A-HJKMNP-TV-Z]{26}$' AND btrim("organization_id") <> ''
         AND btrim("rfq_id") <> '' AND "supplier_organization_id" <> "organization_id"
         AND btrim("submitted_by") <> '' AND btrim("updated_by") <> '');

-- PROCUREMENT_QUOTATION_MAX_REVISIONS is at most 20 (× 500 invitees = the 10000 links
-- audit-service returns of one chain).
ALTER TABLE "quotation" ADD CONSTRAINT "ck_quotation_revision" CHECK ("revision" BETWEEN 1 AND 20);

-- The seal (`@rasta/sealing`): AES-256-GCM (12-byte nonce, 16-byte tag) under a content key wrapped
-- by the RFQ's RSA-3072 key; the commitment and the digest are lowercase hex SHA-256.
ALTER TABLE "quotation" ADD CONSTRAINT "ck_quotation_seal"
  CHECK ("seal_version" = 1 AND btrim("key_id") <> ''
         AND octet_length("nonce") = 12 AND octet_length("tag") = 16
         AND octet_length("ciphertext") > 0 AND octet_length("wrapped_content_key") > 0
         AND "content_commitment" ~ '^[0-9a-f]{64}$' AND "ciphertext_sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "quotation" ADD CONSTRAINT "ck_quotation_withdrawn"
  CHECK ((("status" = 'WITHDRAWN') = ("withdrawn_at" IS NOT NULL))
         AND ("withdrawn_at" IS NULL OR "withdrawn_at" >= "received_at"));

ALTER TABLE "quotation" ADD CONSTRAINT "ck_quotation_timestamps"
  CHECK ("received_at" >= "submitted_at" AND "updated_at" >= "received_at");

-- ---- quotation_receipt -------------------------------------------------------------

ALTER TABLE "quotation_receipt" ADD CONSTRAINT "fk_quotation_receipt_quotation"
  FOREIGN KEY ("organization_id", "rfq_id", "quotation_id")
  REFERENCES "quotation" ("organization_id", "rfq_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "quotation_receipt" ADD CONSTRAINT "ck_quotation_receipt_shape"
  CHECK ("seq" BETWEEN 1 AND 10000 AND "revision" BETWEEN 1 AND 20
         AND "receipt" ~ '^[0-9a-f]{64}$' AND "previous_receipt" ~ '^[0-9a-f]{64}$'
         AND "receipt" <> "previous_receipt"
         AND "content_commitment" ~ '^[0-9a-f]{64}$' AND "ciphertext_sha256" ~ '^[0-9a-f]{64}$');

-- =============================================================================
-- What the database keeps (ADR-063 § 1, ADR-065 § 2)
-- =============================================================================

-- A submission, a revision and a withdrawal are a supplier's acts before the deadline, on the
-- database's own clock; everything else of a quotation never changes.
CREATE FUNCTION "quotation_guard"() RETURNS trigger AS $$
DECLARE
  rfq_status TEXT;
  closes TIMESTAMPTZ(3);
  rfq_key TEXT;
  judged BOOLEAN := false;
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'ck_quotation_not_erasable: a quotation is never deleted or truncated (% refused)', TG_OP
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'SUBMITTED' OR NEW."revision" <> 1 OR NEW."withdrawn_at" IS NOT NULL
       OR NEW."received_at" <> NEW."submitted_at" THEN
      RAISE EXCEPTION 'ck_quotation_born_submitted: a quotation is born SUBMITTED at revision 1'
        USING ERRCODE = 'check_violation';
    END IF;
    judged := true;
  ELSE
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."rfq_id" IS DISTINCT FROM OLD."rfq_id"
       OR NEW."supplier_organization_id" IS DISTINCT FROM OLD."supplier_organization_id"
       OR NEW."key_id" IS DISTINCT FROM OLD."key_id"
       OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
       OR NEW."submitted_by" IS DISTINCT FROM OLD."submitted_by" THEN
      RAISE EXCEPTION 'ck_quotation_immutable: the identity of a quotation never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'SUBMITTED' THEN
      RAISE EXCEPTION 'ck_quotation_immutable: a % quotation never changes', OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."revision" <> OLD."revision" AND (NEW."revision" <> OLD."revision" + 1 OR NEW."status" <> 'SUBMITTED') THEN
      RAISE EXCEPTION 'ck_quotation_revision_step: a revision is the next one, of a SUBMITTED quotation'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."revision" = OLD."revision"
       AND (NEW."seal_version" <> OLD."seal_version" OR NEW."nonce" <> OLD."nonce"
            OR NEW."ciphertext" <> OLD."ciphertext" OR NEW."tag" <> OLD."tag"
            OR NEW."wrapped_content_key" <> OLD."wrapped_content_key"
            OR NEW."content_commitment" <> OLD."content_commitment"
            OR NEW."ciphertext_sha256" <> OLD."ciphertext_sha256"
            OR NEW."received_at" <> OLD."received_at") THEN
      RAISE EXCEPTION 'ck_quotation_immutable: the sealed content changes only with a new revision'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NEW."revision" <> OLD."revision" THEN
      RAISE EXCEPTION 'ck_quotation_transition: a withdrawal seals nothing'
        USING ERRCODE = 'check_violation';
    END IF;
    judged := NEW."revision" <> OLD."revision" OR NEW."status" <> OLD."status";
  END IF;

  IF judged THEN
    SELECT "status", "quotation_closing_at", "key_id" INTO rfq_status, closes, rfq_key
      FROM "rfq" WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."rfq_id";
    -- Half-open: at `quotation_closing_at` a quotation is refused, and a PUBLISHED RFQ the sweeper
    -- has not yet closed refuses too — the clock is trusted, not the status.
    IF rfq_status IS DISTINCT FROM 'PUBLISHED' OR clock_timestamp() >= closes THEN
      RAISE EXCEPTION 'ck_quotation_window: a quotation is submitted, revised or withdrawn only while its RFQ is PUBLISHED and before its quotation deadline'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."key_id" IS DISTINCT FROM rfq_key THEN
      RAISE EXCEPTION 'ck_quotation_key: a quotation is sealed under its RFQ''s key'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_quotation_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "quotation"
  FOR EACH ROW EXECUTE FUNCTION "quotation_guard"();

CREATE TRIGGER "tg_quotation_no_truncate"
  BEFORE TRUNCATE ON "quotation"
  FOR EACH STATEMENT EXECUTE FUNCTION "quotation_guard"();

-- A link is appended in order and continues the chain; once written it never changes.
CREATE FUNCTION "quotation_receipt_guard"() RETURNS trigger AS $$
DECLARE
  expected TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'ck_quotation_receipt_append_only: quotation_receipt is append-only (% refused)', TG_OP
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" = 1 THEN
    -- The genesis: SHA-256 over the length-prefixed label and the RFQ id — the bytes `@rasta/sealing`
    -- computes with the label procurement seals under, and audit-service recomputes.
    expected := encode(sha256(
                  int4send(octet_length(convert_to('rasta.quotation.receipt.genesis.v1', 'UTF8')))
                  || convert_to('rasta.quotation.receipt.genesis.v1', 'UTF8')
                  || int4send(octet_length(convert_to(NEW."rfq_id", 'UTF8')))
                  || convert_to(NEW."rfq_id", 'UTF8')), 'hex');
  ELSE
    SELECT "receipt" INTO expected FROM "quotation_receipt"
     WHERE "organization_id" = NEW."organization_id" AND "rfq_id" = NEW."rfq_id" AND "seq" = NEW."seq" - 1;
  END IF;
  IF expected IS NULL OR NEW."previous_receipt" <> expected THEN
    RAISE EXCEPTION 'ck_quotation_receipt_chain: a link continues the link before it, the first one the genesis'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_quotation_receipt_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "quotation_receipt"
  FOR EACH ROW EXECUTE FUNCTION "quotation_receipt_guard"();

CREATE TRIGGER "tg_quotation_receipt_no_truncate"
  BEFORE TRUNCATE ON "quotation_receipt"
  FOR EACH STATEMENT EXECUTE FUNCTION "quotation_receipt_guard"();

-- At commit, a quotation's current revision is linked: a seal with no receipt, or a receipt of
-- other bytes, is refused. Deferred, so the quotation and its link may be written in either order.
CREATE FUNCTION "quotation_receipt_check"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."revision" = OLD."revision" THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "quotation_receipt"
     WHERE "organization_id" = NEW."organization_id" AND "rfq_id" = NEW."rfq_id"
       AND "quotation_id" = NEW."id" AND "revision" = NEW."revision"
       AND "content_commitment" = NEW."content_commitment"
       AND "ciphertext_sha256" = NEW."ciphertext_sha256"
       AND "received_at" = NEW."received_at") THEN
    RAISE EXCEPTION 'ck_quotation_receipted: every sealed revision of a quotation has its receipt'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_quotation_receipt_check"
  AFTER INSERT OR UPDATE ON "quotation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "quotation_receipt_check"();
