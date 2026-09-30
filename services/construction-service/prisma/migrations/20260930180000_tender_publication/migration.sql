-- =============================================================================
-- construction-service — publishing a tender (CON-002 PR 4b, ADR-065, ADR-066 § 2)
--
-- Who was invited to a restricted tender, the tender's key pair (the private half
-- only ever wrapped), and when and by whom a tender was published.
-- =============================================================================

-- AlterTable
ALTER TABLE "tender" ADD COLUMN "published_at" TIMESTAMP(3),
ADD COLUMN "published_by" TEXT;

-- CreateTable
CREATE TABLE "tender_invitation" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "invited_organization_id" TEXT NOT NULL,
    "invited_at" TIMESTAMP(3) NOT NULL,
    "invited_by" TEXT NOT NULL,

    CONSTRAINT "tender_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_key" (
    "tender_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "public_key_pem" TEXT NOT NULL,
    "kek_id" TEXT NOT NULL,
    "wrap_nonce" BYTEA NOT NULL,
    "wrapped_private_key" BYTEA NOT NULL,
    "wrap_tag" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "tender_key_pkey" PRIMARY KEY ("tender_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_tender_invitation_org" ON "tender_invitation"("tender_id", "invited_organization_id");

-- CreateIndex
CREATE INDEX "ix_tender_invitation_org_tender" ON "tender_invitation"("organization_id", "tender_id");

-- CreateIndex
CREATE INDEX "ix_tender_invitation_invited" ON "tender_invitation"("invited_organization_id", "tender_id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_key_key_id_key" ON "tender_key"("key_id");

-- CreateIndex
CREATE INDEX "ix_tender_key_org_tender" ON "tender_key"("organization_id", "tender_id");

-- AddForeignKey
ALTER TABLE "tender_invitation" ADD CONSTRAINT "tender_invitation_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_key" ADD CONSTRAINT "tender_key_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

-- Publication names who and when, both or neither; a tender that is or was open
-- for bids has them (`status::text`: see the tender_core migration).
ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_publication_complete"
  CHECK (num_nonnulls("published_at", "published_by") IN (0, 2)
         AND ("status"::text NOT IN ('PUBLISHED', 'CLOSED', 'EVALUATING', 'EVALUATED', 'AWARDED')
              OR "published_at" IS NOT NULL)
         AND ("published_by" IS NULL OR btrim("published_by") <> ''));

-- A tender is not published before it was made.
ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_published_after_created"
  CHECK ("published_at" IS NULL OR "published_at" >= "created_at");

-- The owner does not invite itself (it cannot bid on its own tender, ADR-067 § 4).
ALTER TABLE "tender_invitation" ADD CONSTRAINT "ck_invitation_not_self"
  CHECK ("invited_organization_id" <> "organization_id");

ALTER TABLE "tender_invitation" ADD CONSTRAINT "ck_invitation_text_not_blank"
  CHECK (btrim("invited_organization_id") <> '' AND btrim("invited_by") <> '');

-- The wrapped key is what the AEAD produced: a 96-bit nonce, a 128-bit tag, and
-- something to decrypt.
ALTER TABLE "tender_key" ADD CONSTRAINT "ck_tender_key_wrap_shape"
  CHECK (octet_length("wrap_nonce") = 12
         AND octet_length("wrap_tag") = 16
         AND octet_length("wrapped_private_key") > 0);

ALTER TABLE "tender_key" ADD CONSTRAINT "ck_tender_key_text_not_blank"
  CHECK (btrim("key_id") <> '' AND btrim("public_key_pem") <> ''
         AND btrim("kek_id") <> '' AND btrim("created_by") <> '');

-- =============================================================================
-- A tender's key is never deleted and its public half never changes: bids are
-- sealed to it. Only the wrapping (kek_id, nonce, wrapped key, tag) may be
-- renewed, which is what rotating a KEK is.
-- =============================================================================

CREATE FUNCTION "tender_key_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ck_tender_key_immutable: a tender key is never deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."tender_id" <> OLD."tender_id"
     OR NEW."organization_id" <> OLD."organization_id"
     OR NEW."key_id" <> OLD."key_id"
     OR NEW."public_key_pem" <> OLD."public_key_pem" THEN
    RAISE EXCEPTION 'ck_tender_key_immutable: the identity and public key of a tender key never change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_tender_key_guard"
  BEFORE UPDATE OR DELETE ON "tender_key"
  FOR EACH ROW EXECUTE FUNCTION "tender_key_guard"();
