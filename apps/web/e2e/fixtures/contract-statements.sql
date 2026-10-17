-- The contract the statement scenarios act on (`e2e/contract-statements.spec.ts`).
--
-- Why rows and not routes: contract-service has no route that creates a contract —
-- one is drafted only by the system, consuming TENDER_AWARDED (ADR-068 § 3) — and
-- reaching that event live is the whole tender pipeline that
-- `tests/e2e/specs/contract/01-contract-lifecycle.e2e-spec.ts` already runs. The
-- statement screens need a contract that is already SIGNED, with both statement
-- chains in force; nothing about how it got there is under test here.
--
-- So this writes, as contract-service's own runtime role and through every check
-- its database keeps (each guard trigger and CHECK below runs as it would for the
-- service), exactly what the service would have written:
--
--   * three approval policies of ORG-DEH-0001, each written as a DRAFT with its
--     steps, then moved DRAFT -> PENDING_PLATFORM_APPROVAL -> ACTIVE the only way
--     `approval_policy_guard` allows: `contract.signature` (its administrator
--     signs), `contract.statement.technical` (one step: ORG-DEH-0001,
--     ORGANIZATION_ADMIN) and `contract.statement.financial` (one step:
--     ORG-DEH-0001, FLEET_MANAGER) — authored by the platform administrator, so a
--     submission asks organization-service nothing;
--   * one contract, ORG-DEH-0001 employing ORG-E2E-CONTRACTOR, drafted, signed
--     by both sides (the employer's signature under the signing policy, as
--     `contract_signature_guard` demands), then DRAFT -> SIGNED.
--
-- The contractor organization exists only here and in the token of the person
-- the scenario provisions into it: contract-service keeps no organization table.
-- Run once per database; a second run changes nothing.

BEGIN;

DO $fixture$
DECLARE
  at constant timestamptz := now() - interval '1 hour';
BEGIN
  IF EXISTS (SELECT 1 FROM "contract" WHERE "id" = 'CTR_E2E_STATEMENTS') THEN
    RETURN;
  END IF;

  INSERT INTO "approval_policy"
    ("id", "organization_id", "author_organization_id", "author_role", "workflow_key",
     "policy_version", "status", "label", "rationale", "created_at", "created_by",
     "created_correlation_id")
  VALUES
    ('POL_E2E_SIGNATURE', 'ORG-DEH-0001', 'ORG-UNION-YAZD', 'SYSTEM_ADMIN', 'contract.signature',
     1, 'DRAFT', 'امضای قرارداد', 'آزمون مرورگر', at, 'USR-SEED-SYSTEM-ADMIN', 'e2e-fixture'),
    ('POL_E2E_TECHNICAL', 'ORG-DEH-0001', 'ORG-UNION-YAZD', 'SYSTEM_ADMIN',
     'contract.statement.technical', 1, 'DRAFT', 'تأیید فنی صورت‌وضعیت', 'آزمون مرورگر', at,
     'USR-SEED-SYSTEM-ADMIN', 'e2e-fixture'),
    ('POL_E2E_FINANCIAL', 'ORG-DEH-0001', 'ORG-UNION-YAZD', 'SYSTEM_ADMIN',
     'contract.statement.financial', 1, 'DRAFT', 'تأیید مالی صورت‌وضعیت', 'آزمون مرورگر', at,
     'USR-SEED-SYSTEM-ADMIN', 'e2e-fixture');

  INSERT INTO "approval_policy_step"
    ("id", "organization_id", "policy_id", "step_order", "authority_organization_id",
     "authority_role", "authority_label")
  VALUES
    ('APS_E2E_SIGNATURE_1', 'ORG-DEH-0001', 'POL_E2E_SIGNATURE', 1, 'ORG-DEH-0001',
     'ORGANIZATION_ADMIN', 'مدیر دهیاری'),
    ('APS_E2E_TECHNICAL_1', 'ORG-DEH-0001', 'POL_E2E_TECHNICAL', 1, 'ORG-DEH-0001',
     'ORGANIZATION_ADMIN', 'ناظر فنی کارفرما'),
    ('APS_E2E_FINANCIAL_1', 'ORG-DEH-0001', 'POL_E2E_FINANCIAL', 1, 'ORG-DEH-0001',
     'FLEET_MANAGER', 'مسئول مالی کارفرما');

  UPDATE "approval_policy"
     SET "status" = 'PENDING_PLATFORM_APPROVAL', "submitted_at" = at,
         "submitted_by" = 'USR-SEED-SYSTEM-ADMIN', "version" = 2
   WHERE "id" IN ('POL_E2E_SIGNATURE', 'POL_E2E_TECHNICAL', 'POL_E2E_FINANCIAL');
  UPDATE "approval_policy"
     SET "status" = 'ACTIVE', "activated_at" = at, "activated_by" = 'USR-SEED-SYSTEM-ADMIN',
         "version" = 3
   WHERE "id" IN ('POL_E2E_SIGNATURE', 'POL_E2E_TECHNICAL', 'POL_E2E_FINANCIAL');

  INSERT INTO "contract"
    ("id", "organization_id", "tender_id", "project_id", "winning_bid_id",
     "contractor_organization_id", "amount_minor", "matrix_digest", "awarded_by", "awarded_at",
     "status", "status_changed_at", "status_changed_by", "source_event_id", "created_at",
     "created_by", "created_correlation_id", "updated_at")
  VALUES
    ('CTR_E2E_STATEMENTS', 'ORG-DEH-0001', 'TND_E2E_STATEMENTS', 'PRJ_E2E_STATEMENTS',
     'BID_E2E_STATEMENTS', 'ORG-E2E-CONTRACTOR', 1000000000000,
     repeat('0', 64), 'USR-SEED-DEHYARI-ADMIN', at, 'DRAFT', at, 'SYSTEM', 'EVT_E2E_STATEMENTS',
     at, 'SYSTEM', 'e2e-fixture', at);

  INSERT INTO "contract_signature"
    ("id", "organization_id", "contract_id", "side", "signer_organization_id", "signed_by",
     "authority_role", "signed_at", "correlation_id", "policy_id", "policy_version")
  VALUES
    ('SIG_E2E_CONTRACTOR', 'ORG-DEH-0001', 'CTR_E2E_STATEMENTS', 'CONTRACTOR',
     'ORG-E2E-CONTRACTOR', 'USR-E2E-CONTRACT-SIGNER', 'CONTRACTOR', at, 'e2e-fixture', NULL, NULL),
    ('SIG_E2E_EMPLOYER', 'ORG-DEH-0001', 'CTR_E2E_STATEMENTS', 'EMPLOYER', 'ORG-DEH-0001',
     'USR-SEED-DEHYARI-ADMIN', 'ORGANIZATION_ADMIN', at, 'e2e-fixture', 'POL_E2E_SIGNATURE', 1);

  UPDATE "contract"
     SET "status" = 'SIGNED', "status_changed_at" = at, "status_changed_by" = 'USR-SEED-DEHYARI-ADMIN',
         "updated_at" = at, "version" = 2
   WHERE "organization_id" = 'ORG-DEH-0001' AND "id" = 'CTR_E2E_STATEMENTS';
END
$fixture$;

COMMIT;
