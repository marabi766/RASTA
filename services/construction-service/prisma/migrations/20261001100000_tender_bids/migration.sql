-- =============================================================================
-- construction-service — bids (CON-002 PR 6, ADR-065 § 1-2, ADR-066 § 2-5)
--
-- A bid is stored sealed (no price, no answer, no note is a column), its receipt
-- chain is append-only, and every read of a bid leaves an append-only row. The
-- database keeps the deadline too: whatever write path forgets, a bid is not
-- accepted outside the tender's window. (The runtime role still owns these tables,
-- docs/23 D-045: the triggers guard against code and forgotten paths.)
-- =============================================================================

-- CreateEnum
CREATE TYPE "BidStatus" AS ENUM ('SUBMITTED', 'WITHDRAWN', 'OPENED', 'QUALIFIED', 'DISQUALIFIED', 'AWARDED', 'NOT_AWARDED');

-- CreateTable
CREATE TABLE "bid" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "bidder_organization_id" TEXT NOT NULL,
    "status" "BidStatus" NOT NULL DEFAULT 'SUBMITTED',
    "revision" INTEGER NOT NULL,
    "seal_version" INTEGER NOT NULL,
    "key_id" TEXT NOT NULL,
    "nonce" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "wrapped_content_key" BYTEA NOT NULL,
    "content_commitment" TEXT NOT NULL,
    "ciphertext_sha256" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "withdrawn_at" TIMESTAMP(3),
    "submitted_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "bid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bid_receipt" (
    "tender_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "organization_id" TEXT NOT NULL,
    "bid_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "ciphertext_sha256" TEXT NOT NULL,
    "content_commitment" TEXT NOT NULL,
    "previous_receipt" TEXT NOT NULL,
    "receipt" TEXT NOT NULL,

    CONSTRAINT "bid_receipt_pkey" PRIMARY KEY ("organization_id","tender_id","seq")
);

-- CreateTable
CREATE TABLE "bid_access_log" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "bid_id" TEXT,
    "accessor_organization_id" TEXT NOT NULL,
    "accessor_user_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "accessed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bid_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_bid_tender_bidder" ON "bid"("organization_id", "tender_id", "bidder_organization_id");

-- CreateIndex
CREATE INDEX "ix_bid_org_tender_status" ON "bid"("organization_id", "tender_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_bid_receipt_receipt" ON "bid_receipt"("receipt");

-- CreateIndex
CREATE INDEX "ix_bid_receipt_org_tender" ON "bid_receipt"("organization_id", "tender_id");

-- CreateIndex
CREATE INDEX "ix_bid_access_org_tender_time" ON "bid_access_log"("organization_id", "tender_id", "accessed_at");

-- AddForeignKey
ALTER TABLE "bid" ADD CONSTRAINT "bid_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bid_receipt" ADD CONSTRAINT "bid_receipt_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bid_access_log" ADD CONSTRAINT "bid_access_log_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================
-- Domain invariants the database keeps
-- =============================================================================

-- The owner does not bid on its own tender (ADR-067 § 4).
ALTER TABLE "bid" ADD CONSTRAINT "ck_bid_not_own_tender"
  CHECK ("bidder_organization_id" <> "organization_id");

ALTER TABLE "bid" ADD CONSTRAINT "ck_bid_revision_positive" CHECK ("revision" >= 1);

-- What a seal produces: a 96-bit nonce, a 128-bit tag, something to decrypt, a wrapped key.
ALTER TABLE "bid" ADD CONSTRAINT "ck_bid_seal_shape"
  CHECK (octet_length("nonce") = 12 AND octet_length("tag") = 16
         AND octet_length("ciphertext") > 0 AND octet_length("wrapped_content_key") > 0
         AND "content_commitment" ~ '^[0-9a-f]{64}$' AND "ciphertext_sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "bid" ADD CONSTRAINT "ck_bid_text_not_blank"
  CHECK (btrim("bidder_organization_id") <> '' AND btrim("key_id") <> ''
         AND btrim("submitted_by") <> '' AND btrim("updated_by") <> '');

ALTER TABLE "bid" ADD CONSTRAINT "ck_bid_withdrawal_recorded"
  CHECK (("status"::text = 'WITHDRAWN') = ("withdrawn_at" IS NOT NULL));

ALTER TABLE "bid" ADD CONSTRAINT "ck_bid_received_after_submitted"
  CHECK ("received_at" >= "submitted_at");

ALTER TABLE "bid_receipt" ADD CONSTRAINT "ck_bid_receipt_shape"
  CHECK ("seq" >= 1 AND "revision" >= 1
         AND "receipt" ~ '^[0-9a-f]{64}$' AND "previous_receipt" ~ '^[0-9a-f]{64}$'
         AND "ciphertext_sha256" ~ '^[0-9a-f]{64}$' AND "content_commitment" ~ '^[0-9a-f]{64}$');

ALTER TABLE "bid_access_log" ADD CONSTRAINT "ck_bid_access_outcome"
  CHECK ("outcome" IN ('GRANTED', 'REFUSED') AND btrim("purpose") <> ''
         AND btrim("accessor_organization_id") <> '' AND btrim("accessor_user_id") <> '');

-- =============================================================================
-- A bid changes only along its documented edges, and is accepted only inside the
-- tender's window (ADR-065 § 2): a new bid, a new revision and a withdrawal are
-- judged by the database clock against the tender's own dates and status. A bid
-- is never deleted.
-- =============================================================================

CREATE FUNCTION "bid_guard"() RETURNS trigger AS $$
DECLARE
  tender_status text;
  opens timestamp(3);
  closes timestamp(3);
  judged boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ck_bid_immutable: a bid is never deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" <> OLD."id" OR NEW."organization_id" <> OLD."organization_id"
       OR NEW."tender_id" <> OLD."tender_id"
       OR NEW."bidder_organization_id" <> OLD."bidder_organization_id"
       OR NEW."submitted_at" <> OLD."submitted_at" THEN
      RAISE EXCEPTION 'ck_bid_immutable: the identity of a bid never changes'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."revision" <> OLD."revision" AND NEW."revision" <> OLD."revision" + 1 THEN
      RAISE EXCEPTION 'ck_bid_revision_step: a revision is the next one'
        USING ERRCODE = 'check_violation';
    END IF;

    -- The sealed bytes change only with a new revision, which is a new seal.
    IF NEW."revision" = OLD."revision"
       AND (NEW."ciphertext" <> OLD."ciphertext" OR NEW."nonce" <> OLD."nonce"
            OR NEW."tag" <> OLD."tag" OR NEW."wrapped_content_key" <> OLD."wrapped_content_key"
            OR NEW."content_commitment" <> OLD."content_commitment"
            OR NEW."ciphertext_sha256" <> OLD."ciphertext_sha256") THEN
      RAISE EXCEPTION 'ck_bid_immutable: sealed content changes only with a new revision'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status"::text = 'SUBMITTED' AND NEW."status"::text IN ('WITHDRAWN', 'OPENED'))
      OR (OLD."status"::text = 'OPENED' AND NEW."status"::text IN ('QUALIFIED', 'DISQUALIFIED'))
      OR (OLD."status"::text = 'QUALIFIED' AND NEW."status"::text IN ('AWARDED', 'NOT_AWARDED'))
    ) THEN
      RAISE EXCEPTION 'ck_bid_status_transition: a bid cannot go from % to %', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;

    -- A replacement of the seal, or a withdrawal, is a bidder's act inside the window.
    judged := NEW."revision" <> OLD."revision" OR NEW."status"::text = 'WITHDRAWN';
  ELSE
    judged := true;
  END IF;

  IF judged THEN
    SELECT "status"::text, "bid_opening_at", "bid_closing_at"
      INTO tender_status, opens, closes
      FROM "tender" WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."tender_id";
    -- Half-open, like the deadline itself: at `bid_closing_at` a bid is refused, and
    -- a PUBLISHED tender whose sweeper has not yet closed it refuses too.
    IF tender_status IS DISTINCT FROM 'PUBLISHED' OR opens IS NULL OR closes IS NULL
       OR clock_timestamp() < opens OR clock_timestamp() >= closes THEN
      RAISE EXCEPTION 'ck_bid_window: a bid is accepted only while the tender is PUBLISHED and inside [bid_opening_at, bid_closing_at)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_bid_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "bid"
  FOR EACH ROW EXECUTE FUNCTION "bid_guard"();

-- =============================================================================
-- The receipt chain and the access log are append-only
-- =============================================================================

CREATE FUNCTION "bid_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ck_bid_append_only: % is append-only (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_bid_receipt_append_only"
  BEFORE UPDATE OR DELETE ON "bid_receipt"
  FOR EACH ROW EXECUTE FUNCTION "bid_append_only"();
CREATE TRIGGER "tg_bid_receipt_no_truncate"
  BEFORE TRUNCATE ON "bid_receipt"
  FOR EACH STATEMENT EXECUTE FUNCTION "bid_append_only"();

CREATE TRIGGER "tg_bid_access_log_append_only"
  BEFORE UPDATE OR DELETE ON "bid_access_log"
  FOR EACH ROW EXECUTE FUNCTION "bid_append_only"();
CREATE TRIGGER "tg_bid_access_log_no_truncate"
  BEFORE TRUNCATE ON "bid_access_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "bid_append_only"();
