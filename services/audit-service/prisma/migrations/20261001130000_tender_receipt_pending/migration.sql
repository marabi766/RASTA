-- =============================================================================
-- audit-service — receipts held until their predecessor arrives (CON-002 PR 6, ADR-066 § 2)
--
-- The relay orders events only inside one claimed batch, so a later receipt can
-- reach the topic before its predecessor. Dead-lettering it would leave the externally
-- held head behind until someone replayed by hand. Instead the receipt is **held**
-- here, durably, keyed by the receipt it continues, and drained in order — in the
-- same transaction — when that predecessor is appended. A gap that stays open past
-- AUDIT_TENDER_GAP_ALERT_SECONDS is counted and alerted (it is never silent).
--
-- This is a work queue, not evidence: held rows are deleted when they are drained,
-- so the runtime role holds SELECT, INSERT and DELETE (and no UPDATE). The evidence
-- itself stays in the append-only `tender_receipt_link`.
-- =============================================================================

-- CreateTable
CREATE TABLE "tender_receipt_pending" (
    "source_event_id" VARCHAR(128) NOT NULL,
    "tender_id" VARCHAR(128) NOT NULL,
    "organization_id" VARCHAR(128) NOT NULL,
    "bidder_organization_id" VARCHAR(128) NOT NULL,
    "bid_id" VARCHAR(128) NOT NULL,
    "revision" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "ciphertext_sha256" CHAR(64) NOT NULL,
    "content_commitment" CHAR(64) NOT NULL,
    "previous_receipt" CHAR(64) NOT NULL,
    "receipt" CHAR(64) NOT NULL,
    "held_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "tender_receipt_pending_pkey" PRIMARY KEY ("source_event_id")
);

-- One held successor per predecessor and one held row per receipt, per tender:
-- a second one is a fork, refused when it arrives.
CREATE UNIQUE INDEX "ux_tender_receipt_pending_previous" ON "tender_receipt_pending"("tender_id", "previous_receipt");
CREATE UNIQUE INDEX "ux_tender_receipt_pending_receipt" ON "tender_receipt_pending"("tender_id", "receipt");
CREATE INDEX "ix_tender_receipt_pending_held" ON "tender_receipt_pending"("held_at");

ALTER TABLE "tender_receipt_pending" ADD CONSTRAINT "ck_tender_receipt_pending_shape"
  CHECK ("revision" >= 1
         AND "receipt" ~ '^[0-9a-f]{64}$' AND "previous_receipt" ~ '^[0-9a-f]{64}$'
         AND "ciphertext_sha256" ~ '^[0-9a-f]{64}$' AND "content_commitment" ~ '^[0-9a-f]{64}$'
         AND "receipt" <> "previous_receipt");

GRANT SELECT, INSERT, DELETE ON "tender_receipt_pending" TO rasta_audit;
