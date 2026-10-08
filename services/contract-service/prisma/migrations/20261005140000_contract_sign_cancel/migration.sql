-- =============================================================================
-- contract-service — sign and cancel (CON-003 PR 2, ADR-068 § 2, Q-95 (1) and (4)).
--
-- Three things:
--
--   * `contract_signature` — one row per side that accepted the draft: the record of
--     who accepted for which party, when, and under which configured authority. It is
--     the audit record of a signature (AGENTS.md S-06): never updated, never deleted.
--     "Signing" is a recorded acceptance by both parties, not a legal signature (Q-95 (1)).
--   * the cancellation on `contract` — a closed reason code and an optional note, set
--     once, with the transition to CANCELLED and with nothing else.
--   * `idempotency_key` — this service's own store for the two commands (docs/06 § 6.8),
--     the shape asset-service and maintenance-service use.
--
-- `contract_guard` is replaced so the database keeps the lifecycle the code declares
-- (`contract.state-machine.ts`): only the declared transitions, a contract is SIGNED
-- only when both sides have signed, a final state never changes. The list below is read
-- by `contract.state-machine.spec.ts`, which fails if it differs from the code's table:
--
--   transitions: DRAFT>SIGNED DRAFT>CANCELLED SIGNED>COMPLETED COMPLETED>SETTLED
-- =============================================================================

-- CreateEnum
CREATE TYPE "ContractSide" AS ENUM ('EMPLOYER', 'CONTRACTOR');

-- ---- contract: the cancellation ----------------------------------------------

ALTER TABLE "contract"
  ADD COLUMN "cancel_reason_code" TEXT,
  ADD COLUMN "cancel_note" TEXT;

-- A reason exists exactly when the contract is cancelled, and a note only with a reason.
-- The code is a closed list the configuration owns (CONTRACT_CANCEL_REASON_CODES), so the
-- database holds its shape only; the note is bounded and carries no bidirectional control.
ALTER TABLE "contract" ADD CONSTRAINT "ck_contract_cancellation"
  CHECK (
    ("status" = 'CANCELLED') = ("cancel_reason_code" IS NOT NULL)
    AND ("cancel_note" IS NULL OR "cancel_reason_code" IS NOT NULL)
    AND ("cancel_reason_code" IS NULL OR "cancel_reason_code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
    AND ("cancel_note" IS NULL
         OR (btrim("cancel_note") <> '' AND length("cancel_note") <= 1000
             AND "cancel_note" !~ '[؜‎‏‪-‮⁦-⁩]'))
  );

-- ---- contract_signature ------------------------------------------------------

-- CreateTable
CREATE TABLE "contract_signature" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "side" "ContractSide" NOT NULL,
    "signer_organization_id" TEXT NOT NULL,
    "signed_by" TEXT NOT NULL,
    "signed_by_issuer" TEXT,
    "signed_by_subject" TEXT,
    "authority_role" TEXT NOT NULL,
    "signed_at" TIMESTAMPTZ(3) NOT NULL,
    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "contract_signature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_contract_signature_side" ON "contract_signature"("organization_id", "contract_id", "side");

-- AddForeignKey
ALTER TABLE "contract_signature" ADD CONSTRAINT "contract_signature_organization_id_contract_id_fkey"
  FOREIGN KEY ("organization_id", "contract_id") REFERENCES "contract"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "contract_signature" ADD CONSTRAINT "ck_signature_text_not_blank"
  CHECK (btrim("organization_id") <> '' AND btrim("contract_id") <> ''
         AND btrim("signer_organization_id") <> '' AND btrim("signed_by") <> ''
         AND btrim("authority_role") <> '' AND btrim("correlation_id") <> '');

-- The person is kept the way every later separation-of-duties check compares one (#188):
-- the token's verified issuer and subject together, or neither — never half of a pair.
ALTER TABLE "contract_signature" ADD CONSTRAINT "ck_signature_identity"
  CHECK (("signed_by_issuer" IS NULL) = ("signed_by_subject" IS NULL)
         AND ("signed_by_issuer" IS NULL
              OR (btrim("signed_by_issuer") <> '' AND btrim("signed_by_subject") <> '')));

-- The role the signature was accepted under, as the configuration named it.
ALTER TABLE "contract_signature" ADD CONSTRAINT "ck_signature_authority_role"
  CHECK ("authority_role" ~ '^[A-Z][A-Z_]*$');

-- A signature is a record, not state: it is written once and never changed or removed, and
-- the database refuses the three ways one could be wrong whatever the code forgets:
--   * a signature on a contract that is no longer a draft;
--   * a signature for a side by an organization that is not that side;
--   * one person on both sides (by user id, or by issuer and subject).
-- What the database cannot prove is "two people", only "provably one": an identity that
-- cannot be compared is refused by the service (422 ACTOR_IDENTITY_UNKNOWN), failing closed.
CREATE FUNCTION "contract_signature_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
  other RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "organization_id", "contractor_organization_id", "status" INTO parent
      FROM "contract"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
    IF NOT FOUND OR parent."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'ck_signature_contract_draft: only a draft contract is signed'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."side" = 'EMPLOYER' AND NEW."signer_organization_id" <> parent."organization_id")
       OR (NEW."side" = 'CONTRACTOR'
           AND NEW."signer_organization_id" <> parent."contractor_organization_id") THEN
      RAISE EXCEPTION 'ck_signature_side_organization: the signer''s organization is not that side of the contract'
        USING ERRCODE = 'check_violation';
    END IF;
    FOR other IN
      SELECT "signed_by", "signed_by_issuer", "signed_by_subject" FROM "contract_signature"
       WHERE "organization_id" = NEW."organization_id" AND "contract_id" = NEW."contract_id"
         AND "side" <> NEW."side"
    LOOP
      IF other."signed_by" = NEW."signed_by"
         OR other."signed_by" = NEW."signed_by_subject"
         OR NEW."signed_by" = other."signed_by_subject"
         OR (other."signed_by_issuer" IS NOT NULL
             AND other."signed_by_issuer" = NEW."signed_by_issuer"
             AND other."signed_by_subject" = NEW."signed_by_subject") THEN
        RAISE EXCEPTION 'ck_signature_one_person_one_side: one person cannot sign for both sides'
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_signature_immutable: a signature is never changed, deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_contract_signature_insert"
  BEFORE INSERT ON "contract_signature"
  FOR EACH ROW EXECUTE FUNCTION "contract_signature_guard"();

CREATE TRIGGER "tg_contract_signature_immutable"
  BEFORE UPDATE OR DELETE ON "contract_signature"
  FOR EACH ROW EXECUTE FUNCTION "contract_signature_guard"();

CREATE TRIGGER "tg_contract_signature_no_truncate"
  BEFORE TRUNCATE ON "contract_signature"
  FOR EACH STATEMENT EXECUTE FUNCTION "contract_signature_guard"();

-- ---- contract_guard: the lifecycle, kept by the database ----------------------

CREATE OR REPLACE FUNCTION "contract_guard"() RETURNS trigger AS $$
DECLARE
  sides integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."tender_id" IS DISTINCT FROM OLD."tender_id"
       OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
       OR NEW."winning_bid_id" IS DISTINCT FROM OLD."winning_bid_id"
       OR NEW."contractor_organization_id" IS DISTINCT FROM OLD."contractor_organization_id"
       OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
       OR NEW."matrix_digest" IS DISTINCT FROM OLD."matrix_digest"
       OR NEW."awarded_by" IS DISTINCT FROM OLD."awarded_by"
       OR NEW."awarded_at" IS DISTINCT FROM OLD."awarded_at"
       OR NEW."source_event_id" IS DISTINCT FROM OLD."source_event_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_contract_origin_immutable: what a contract was made from never changes'
        USING ERRCODE = 'check_violation';
    END IF;

    -- A cancelled or settled contract is history: nothing about it changes again.
    IF OLD."status" IN ('CANCELLED', 'SETTLED') THEN
      RAISE EXCEPTION 'ck_contract_final: a % contract never changes', OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      IF NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('SIGNED', 'CANCELLED'))
              OR (OLD."status" = 'SIGNED' AND NEW."status" = 'COMPLETED')
              OR (OLD."status" = 'COMPLETED' AND NEW."status" = 'SETTLED')) THEN
        RAISE EXCEPTION 'ck_contract_transition: a contract cannot move from % to %', OLD."status", NEW."status"
          USING ERRCODE = 'check_violation';
      END IF;
      -- Both parties have accepted, or the contract is not signed (Q-95 (1)).
      IF NEW."status" = 'SIGNED' THEN
        SELECT count(DISTINCT "side") INTO sides FROM "contract_signature"
         WHERE "organization_id" = NEW."organization_id" AND "contract_id" = NEW."id";
        IF sides <> 2 THEN
          RAISE EXCEPTION 'ck_contract_signed_by_both: a contract is signed only when both sides have signed'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;

    IF OLD."cancel_reason_code" IS NOT NULL
       AND (NEW."cancel_reason_code" IS DISTINCT FROM OLD."cancel_reason_code"
            OR NEW."cancel_note" IS DISTINCT FROM OLD."cancel_note") THEN
      RAISE EXCEPTION 'ck_contract_cancellation_immutable: the reason a contract was cancelled never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_contract_not_erasable: a contract is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- ---- idempotency_key ----------------------------------------------------------

-- CreateTable
CREATE TABLE "idempotency_key" (
    "key" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "claim_token" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "state" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("organization_id", "endpoint", "key")
);

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

ALTER TABLE "idempotency_key"
  ADD CONSTRAINT "ck_idempotency_state" CHECK ("state" IN ('IN_PROGRESS', 'COMPLETED')),
  ADD CONSTRAINT "ck_idempotency_key_not_blank" CHECK (length(btrim("key")) > 0),
  ADD CONSTRAINT "ck_idempotency_claim_token_not_blank" CHECK (length(btrim("claim_token")) > 0),
  ADD CONSTRAINT "ck_idempotency_completed_has_response" CHECK (
    "state" <> 'COMPLETED' OR ("response_status" IS NOT NULL AND "response_body" IS NOT NULL)
  );
