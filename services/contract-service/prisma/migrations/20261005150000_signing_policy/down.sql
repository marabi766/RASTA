-- =============================================================================
-- Reverse of `migration.sql` (CON-003 PR 2, review round 1).
--
-- **Refuses, and changes nothing, once the policy store has been used.** An approval policy is
-- the record of who was allowed to sign for an employer and who put that in force, and a
-- signature names the policy that authorised it: dropping either would leave employer signatures
-- (and SIGNED contracts) with no authority behind them. So this script stops, with a message,
-- when any `approval_policy` row exists or any signature names a policy. On a database where the
-- store was never used it restores the previous schema exactly. Roll the code back first: it
-- reads and writes all of these.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be re-applied.
--
-- The whole file is one transaction (`BEGIN; … COMMIT;`): run with `psql --file` (autocommit by
-- default) the lock would otherwise end before the check and a policy or signature could commit
-- between the check and the drops, and a refusal need not stop the statements after it. Inside it
-- the lock, the check that RAISEs and every change commit together or not at all. Run it with
-- `-v ON_ERROR_STOP=1`; without it a refusal still leaves nothing changed (the transaction aborts).
-- =============================================================================

BEGIN;

-- Locked first, so no policy or signature can be written between the check and the drops.
LOCK TABLE "approval_policy", "approval_policy_step", "contract_signature" IN ACCESS EXCLUSIVE MODE;

DO $preflight_policy$
DECLARE
  policies integer;
  signed integer;
BEGIN
  SELECT count(*) INTO policies FROM "approval_policy";
  SELECT count(*) INTO signed FROM "contract_signature" WHERE "policy_id" IS NOT NULL;
  IF policies > 0 OR signed > 0 THEN
    RAISE EXCEPTION 'down refused: % approval polic(ies) and % employer signature(s) name them; nothing was changed', policies, signed
      USING ERRCODE = 'check_violation';
  END IF;
END
$preflight_policy$;

-- The signature guard as the previous migration left it.
CREATE OR REPLACE FUNCTION "contract_signature_guard"() RETURNS trigger AS $$
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

ALTER TABLE "contract_signature" DROP CONSTRAINT IF EXISTS "ck_signature_policy";
ALTER TABLE "contract_signature" DROP CONSTRAINT IF EXISTS "contract_signature_organization_id_policy_id_fkey";
ALTER TABLE "contract_signature"
  DROP COLUMN IF EXISTS "policy_version",
  DROP COLUMN IF EXISTS "policy_id";

DROP TRIGGER IF EXISTS "tg_approval_policy_step_no_truncate" ON "approval_policy_step";
DROP TRIGGER IF EXISTS "tg_approval_policy_step_immutable" ON "approval_policy_step";
DROP TRIGGER IF EXISTS "tg_approval_policy_step_insert" ON "approval_policy_step";
DROP FUNCTION IF EXISTS "approval_policy_step_guard"();

DROP TRIGGER IF EXISTS "tg_approval_policy_no_truncate" ON "approval_policy";
DROP TRIGGER IF EXISTS "tg_approval_policy_guard" ON "approval_policy";
DROP FUNCTION IF EXISTS "approval_policy_guard"();

DROP TABLE IF EXISTS "approval_policy_step";
DROP TABLE IF EXISTS "approval_policy";

DROP TYPE IF EXISTS "ApprovalPolicyStatus";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261005150000_signing_policy';

COMMIT;
