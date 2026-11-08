-- =============================================================================
-- audit-service — the RFQ-evidence projection (COM-007 PR 7, ADR-070 § 4, ADR-066 § 2-3)
--
-- The same two tables the tender-evidence projection has for bids, for quotations:
--
--   rfq_receipt_link     one row per QUOTATION_SUBMITTED / QUOTATION_REVISED: the RFQ's
--                        receipt chain as announced when each quotation was made. This is
--                        the **externally held head** procurement-service opens quotations
--                        against (it cannot rewrite these rows: it has no access to this
--                        database). Link continuity is checked on insert. Append-only.
--   rfq_receipt_pending  receipts held until their predecessor arrives (the relay orders
--                        events only inside one claimed batch). A work queue, not evidence:
--                        a held row is deleted when it is drained into the chain.
--
-- Same privilege split as the rest of this schema: the migrator owns the tables, the
-- runtime role `rasta_audit` holds SELECT and INSERT (and DELETE on the work queue) and
-- nothing else, and a trigger refuses UPDATE, DELETE and TRUNCATE on the evidence for
-- everybody (the owner included, until it drops the trigger on purpose).
--
-- No access-evidence table: a quotation read is `quotation_access_log` in
-- procurement-service (plan PR 8); the QUOTATION_ACCESSED event is an ordinary audit row.
-- =============================================================================

-- CreateTable
CREATE TABLE "rfq_receipt_link" (
    "rfq_id" VARCHAR(128) NOT NULL,
    "seq" INTEGER NOT NULL,
    "organization_id" VARCHAR(128) NOT NULL,
    "supplier_organization_id" VARCHAR(128) NOT NULL,
    "quotation_id" VARCHAR(128) NOT NULL,
    "revision" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "ciphertext_sha256" CHAR(64) NOT NULL,
    "content_commitment" CHAR(64) NOT NULL,
    "previous_receipt" CHAR(64) NOT NULL,
    "receipt" CHAR(64) NOT NULL,
    "source_event_id" VARCHAR(128) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "rfq_receipt_link_pkey" PRIMARY KEY ("rfq_id","seq")
);

-- CreateTable
CREATE TABLE "rfq_receipt_pending" (
    "source_event_id" VARCHAR(128) NOT NULL,
    "rfq_id" VARCHAR(128) NOT NULL,
    "organization_id" VARCHAR(128) NOT NULL,
    "supplier_organization_id" VARCHAR(128) NOT NULL,
    "quotation_id" VARCHAR(128) NOT NULL,
    "revision" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "ciphertext_sha256" CHAR(64) NOT NULL,
    "content_commitment" CHAR(64) NOT NULL,
    "previous_receipt" CHAR(64) NOT NULL,
    "receipt" CHAR(64) NOT NULL,
    "held_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "rfq_receipt_pending_pkey" PRIMARY KEY ("source_event_id")
);

-- A receipt is one link, and a link has one successor: no repeated receipt, no fork.
CREATE UNIQUE INDEX "ux_rfq_receipt_link_receipt" ON "rfq_receipt_link"("rfq_id", "receipt");
CREATE UNIQUE INDEX "ux_rfq_receipt_link_previous" ON "rfq_receipt_link"("rfq_id", "previous_receipt");
CREATE UNIQUE INDEX "ux_rfq_receipt_link_event" ON "rfq_receipt_link"("source_event_id");

-- One held successor per predecessor and one held row per receipt, per RFQ:
-- a second one is a fork, refused when it arrives.
CREATE UNIQUE INDEX "ux_rfq_receipt_pending_previous" ON "rfq_receipt_pending"("rfq_id", "previous_receipt");
CREATE UNIQUE INDEX "ux_rfq_receipt_pending_receipt" ON "rfq_receipt_pending"("rfq_id", "receipt");
CREATE INDEX "ix_rfq_receipt_pending_held" ON "rfq_receipt_pending"("held_at");

ALTER TABLE "rfq_receipt_link" ADD CONSTRAINT "ck_rfq_receipt_link_shape"
  CHECK ("seq" >= 1 AND "revision" >= 1
         AND "receipt" ~ '^[0-9a-f]{64}$' AND "previous_receipt" ~ '^[0-9a-f]{64}$'
         AND "ciphertext_sha256" ~ '^[0-9a-f]{64}$' AND "content_commitment" ~ '^[0-9a-f]{64}$'
         AND "receipt" <> "previous_receipt");

ALTER TABLE "rfq_receipt_pending" ADD CONSTRAINT "ck_rfq_receipt_pending_shape"
  CHECK ("revision" >= 1
         AND "receipt" ~ '^[0-9a-f]{64}$' AND "previous_receipt" ~ '^[0-9a-f]{64}$'
         AND "ciphertext_sha256" ~ '^[0-9a-f]{64}$' AND "content_commitment" ~ '^[0-9a-f]{64}$'
         AND "receipt" <> "previous_receipt");

-- =============================================================================
-- One identity across both states
-- =============================================================================

-- A receipt, or a successor of one predecessor, belongs to ONE event of an RFQ, whether that
-- event's row is placed in the chain or still held. The unique indexes above are per table; this
-- is the rule across the two (a receipt held in `rfq_receipt_pending` and the same receipt
-- committed through another event is two claims on one link). Moving a held row into the chain
-- is the same event (same `source_event_id`) and is allowed. The consumer serializes writers per
-- RFQ with an advisory lock and checks the same pair first; this is the guarantee that does not
-- depend on the consumer's code.
CREATE FUNCTION "rfq_receipt_identity_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'rfq_receipt_link' THEN
    IF EXISTS (SELECT 1 FROM "rfq_receipt_pending" p
                WHERE p."rfq_id" = NEW."rfq_id" AND p."source_event_id" <> NEW."source_event_id"
                  AND (p."receipt" = NEW."receipt" OR p."previous_receipt" = NEW."previous_receipt")) THEN
      RAISE EXCEPTION 'ck_rfq_receipt_identity: a held receipt already claims this receipt or predecessor'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "rfq_receipt_link" l
                WHERE l."rfq_id" = NEW."rfq_id" AND l."source_event_id" <> NEW."source_event_id"
                  AND (l."receipt" = NEW."receipt" OR l."previous_receipt" = NEW."previous_receipt")) THEN
      RAISE EXCEPTION 'ck_rfq_receipt_identity: a placed link already claims this receipt or predecessor'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_rfq_receipt_link_identity"
  BEFORE INSERT ON "rfq_receipt_link"
  FOR EACH ROW EXECUTE FUNCTION "rfq_receipt_identity_guard"();
CREATE TRIGGER "tg_rfq_receipt_pending_identity"
  BEFORE INSERT ON "rfq_receipt_pending"
  FOR EACH ROW EXECUTE FUNCTION "rfq_receipt_identity_guard"();

-- =============================================================================
-- Append-only, for everybody
-- =============================================================================

CREATE FUNCTION "rfq_evidence_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ck_rfq_evidence_append_only: % is append-only (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_rfq_receipt_link_append_only"
  BEFORE UPDATE OR DELETE ON "rfq_receipt_link"
  FOR EACH ROW EXECUTE FUNCTION "rfq_evidence_append_only"();
CREATE TRIGGER "tg_rfq_receipt_link_no_truncate"
  BEFORE TRUNCATE ON "rfq_receipt_link"
  FOR EACH STATEMENT EXECUTE FUNCTION "rfq_evidence_append_only"();

-- The runtime role reads and appends; it owns nothing here. The work queue is also drained
-- (DELETE), never updated.
GRANT SELECT, INSERT ON "rfq_receipt_link" TO rasta_audit;
GRANT SELECT, INSERT, DELETE ON "rfq_receipt_pending" TO rasta_audit;
