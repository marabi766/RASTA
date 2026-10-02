-- =============================================================================
-- audit-service — why a read of a bid was refused (CON-002 PR 9, ADR-066 § 5, ADR-067 § 4)
--
-- BID_ACCESSED now carries `refusalCode`: a closed code (CONFLICT_OF_INTEREST, NOT_OPENED,
-- RECUSED, NOT_FOUND …), null when the read was granted. The evidence keeps it beside the
-- real outcome. Nullable, additive; a row written before this has none. The table stays
-- append-only (its triggers are untouched) and an event without the field still projects.
-- =============================================================================

-- AlterTable
ALTER TABLE "bid_access_evidence" ADD COLUMN "refusal_code" VARCHAR(64);

-- Only a refusal has a reason, and it is a closed code, not prose.
ALTER TABLE "bid_access_evidence" ADD CONSTRAINT "ck_bid_access_evidence_refusal_code"
  CHECK ("refusal_code" IS NULL
         OR ("outcome" = 'REFUSED' AND "refusal_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'));
