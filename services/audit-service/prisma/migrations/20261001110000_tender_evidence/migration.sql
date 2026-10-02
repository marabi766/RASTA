-- =============================================================================
-- audit-service — the tender-evidence projection (CON-002 PR 6, ADR-066 § 2-3, § 5)
--
-- Two append-only tables, written by one consumer of `rasta.construction.v1`:
--
--   tender_receipt_link   one row per BID_SUBMITTED / BID_REVISED: the tender's
--                         receipt chain as announced when each bid was made. This is
--                         the **externally held head** construction-service opens bids
--                         against (it cannot rewrite these rows: it has no access to
--                         this database). Link continuity is checked on insert.
--   bid_access_evidence   one row per BID_ACCESSED: who read which bid, why, and the
--                         **real outcome** (granted or refused) — identifiers only.
--
-- Same privilege split as the rest of this schema: the migrator owns the tables, the
-- runtime role `rasta_audit` holds SELECT and INSERT and nothing else, and a trigger
-- refuses UPDATE, DELETE and TRUNCATE for everybody (the owner included, until it
-- drops the trigger on purpose).
-- =============================================================================

-- CreateTable
CREATE TABLE "tender_receipt_link" (
    "tender_id" VARCHAR(128) NOT NULL,
    "seq" INTEGER NOT NULL,
    "organization_id" VARCHAR(128) NOT NULL,
    "bidder_organization_id" VARCHAR(128) NOT NULL,
    "bid_id" VARCHAR(128) NOT NULL,
    "revision" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "ciphertext_sha256" CHAR(64) NOT NULL,
    "content_commitment" CHAR(64) NOT NULL,
    "previous_receipt" CHAR(64) NOT NULL,
    "receipt" CHAR(64) NOT NULL,
    "source_event_id" VARCHAR(128) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "tender_receipt_link_pkey" PRIMARY KEY ("tender_id","seq")
);

-- CreateTable
CREATE TABLE "bid_access_evidence" (
    "source_event_id" VARCHAR(128) NOT NULL,
    "tender_id" VARCHAR(128) NOT NULL,
    "organization_id" VARCHAR(128) NOT NULL,
    "bid_id" VARCHAR(128),
    "accessor_organization_id" VARCHAR(128) NOT NULL,
    "accessed_by" VARCHAR(128) NOT NULL,
    "purpose" VARCHAR(64) NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "accessed_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "bid_access_evidence_pkey" PRIMARY KEY ("source_event_id")
);

-- A receipt is one link, and a link has one successor: no repeated receipt, no fork.
CREATE UNIQUE INDEX "ux_tender_receipt_link_receipt" ON "tender_receipt_link"("tender_id", "receipt");
CREATE UNIQUE INDEX "ux_tender_receipt_link_previous" ON "tender_receipt_link"("tender_id", "previous_receipt");
CREATE UNIQUE INDEX "ux_tender_receipt_link_event" ON "tender_receipt_link"("source_event_id");

CREATE INDEX "ix_bid_access_evidence_tender" ON "bid_access_evidence"("tender_id", "accessed_at");

ALTER TABLE "tender_receipt_link" ADD CONSTRAINT "ck_tender_receipt_link_shape"
  CHECK ("seq" >= 1 AND "revision" >= 1
         AND "receipt" ~ '^[0-9a-f]{64}$' AND "previous_receipt" ~ '^[0-9a-f]{64}$'
         AND "ciphertext_sha256" ~ '^[0-9a-f]{64}$' AND "content_commitment" ~ '^[0-9a-f]{64}$'
         AND "receipt" <> "previous_receipt");

ALTER TABLE "bid_access_evidence" ADD CONSTRAINT "ck_bid_access_evidence_shape"
  CHECK ("outcome" IN ('GRANTED', 'REFUSED') AND btrim("purpose") <> '');

-- =============================================================================
-- Append-only, for everybody
-- =============================================================================

CREATE FUNCTION "tender_evidence_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ck_tender_evidence_append_only: % is append-only (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_tender_receipt_link_append_only"
  BEFORE UPDATE OR DELETE ON "tender_receipt_link"
  FOR EACH ROW EXECUTE FUNCTION "tender_evidence_append_only"();
CREATE TRIGGER "tg_tender_receipt_link_no_truncate"
  BEFORE TRUNCATE ON "tender_receipt_link"
  FOR EACH STATEMENT EXECUTE FUNCTION "tender_evidence_append_only"();

CREATE TRIGGER "tg_bid_access_evidence_append_only"
  BEFORE UPDATE OR DELETE ON "bid_access_evidence"
  FOR EACH ROW EXECUTE FUNCTION "tender_evidence_append_only"();
CREATE TRIGGER "tg_bid_access_evidence_no_truncate"
  BEFORE TRUNCATE ON "bid_access_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION "tender_evidence_append_only"();

-- The runtime role reads and appends; it owns nothing here.
GRANT SELECT, INSERT ON "tender_receipt_link" TO rasta_audit;
GRANT SELECT, INSERT ON "bid_access_evidence" TO rasta_audit;
