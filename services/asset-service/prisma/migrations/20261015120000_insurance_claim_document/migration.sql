-- Documents attached to an insurance claim (COM-010 criterion 2, docs/24 Q-128).
--
-- A reference only: the file stays in document-service (ADR-014) and the id is
-- checked against it before a row is written. The row belongs to the
-- organization that attached the document and does NOT move with the claim on
-- an ownership transfer (the Q-99 rule for asset documents): the new owner
-- sees the claim and none of the previous owner's files.
--
-- Additive: one new table, no existing row touched, nothing to backfill.
-- Every index leads with organization_id (check-tenant-index-order).
BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE "insurance_claim_document" (
    "id" TEXT NOT NULL,
    "claim_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    -- Set once when document-service reports the file deleted after it was
    -- attached; the row is kept (the claim's record of what was filed).
    "document_removed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "insurance_claim_document_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_claim_document_ids_not_blank" CHECK (
        length(btrim("document_id")) > 0 AND length(btrim("organization_id")) > 0
    )
);

-- One reference per document per claim: attaching it again is the same fact.
CREATE UNIQUE INDEX "insurance_claim_document_org_claim_doc_key"
    ON "insurance_claim_document"("organization_id", "claim_id", "document_id");

-- The list a claim read shows, oldest first.
CREATE INDEX "insurance_claim_document_org_claim_created_idx"
    ON "insurance_claim_document"("organization_id", "claim_id", "created_at");

-- The deletion event finds the references to one document in one tenant.
CREATE INDEX "insurance_claim_document_org_doc_idx"
    ON "insurance_claim_document"("organization_id", "document_id");

ALTER TABLE "insurance_claim_document"
    ADD CONSTRAINT "insurance_claim_document_claim_id_fkey"
    FOREIGN KEY ("claim_id") REFERENCES "insurance_claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
