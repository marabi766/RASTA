-- The draft contracts the contract command scenarios act on (`e2e/contract-commands.spec.ts`).
--
-- Why rows and not routes: as `contract-statements.sql` says, contract-service has no
-- route that creates a contract — one is drafted only by the system, consuming
-- TENDER_AWARDED (ADR-068 § 3). These scenarios start from **drafts nobody has signed**
-- and do everything else through the portal's own forms: both signatures, the
-- cancellation, the amendment and both of its signatures, the milestone and its change.
--
-- Loaded after `contract-statements.sql`, whose `contract.signature` policy of
-- ORG-DEH-0001 (its ORGANIZATION_ADMIN signs) is the one the employer signs under here.
-- Written as contract-service's own runtime role, through every check its database
-- keeps — a contract is inserted as a DRAFT, as `contract_guard` allows.
--
--   * CTR_E2E_SIGNING   — ORG-DEH-0001 employs ORG-E2E-CONTRACTOR: signed by both sides
--                         in the browser, then amended and planned.
--   * CTR_E2E_CANCEL    — the same parties: the employer opens its cancel form, the
--                         contractor signs first, and the stale cancellation is refused
--                         (`SIGNATURE_RECORDED`).
--   * CTR_E2E_UNGOVERNED — ORG-DEH-0002 employs ORG-E2E-CONTRACTOR: no signing policy is
--                         in force for ORG-DEH-0002, so nobody may sign for it.
--
-- Run once per database; a second run changes nothing.

BEGIN;

DO $fixture$
DECLARE
  at constant timestamptz := now() - interval '1 hour';
BEGIN
  IF EXISTS (SELECT 1 FROM "contract" WHERE "id" = 'CTR_E2E_SIGNING') THEN
    RETURN;
  END IF;

  INSERT INTO "contract"
    ("id", "organization_id", "tender_id", "project_id", "winning_bid_id",
     "contractor_organization_id", "amount_minor", "matrix_digest", "awarded_by", "awarded_at",
     "status", "status_changed_at", "status_changed_by", "source_event_id", "created_at",
     "created_by", "created_correlation_id", "updated_at")
  VALUES
    ('CTR_E2E_SIGNING', 'ORG-DEH-0001', 'TND_E2E_SIGNING', 'PRJ_E2E_SIGNING', 'BID_E2E_SIGNING',
     'ORG-E2E-CONTRACTOR', 500000000, repeat('0', 64), 'USR-SEED-DEHYARI-ADMIN', at, 'DRAFT', at,
     'SYSTEM', 'EVT_E2E_SIGNING', at, 'SYSTEM', 'e2e-fixture', at),
    ('CTR_E2E_CANCEL', 'ORG-DEH-0001', 'TND_E2E_CANCEL', 'PRJ_E2E_CANCEL', 'BID_E2E_CANCEL',
     'ORG-E2E-CONTRACTOR', 300000000, repeat('0', 64), 'USR-SEED-DEHYARI-ADMIN', at, 'DRAFT', at,
     'SYSTEM', 'EVT_E2E_CANCEL', at, 'SYSTEM', 'e2e-fixture', at),
    ('CTR_E2E_UNGOVERNED', 'ORG-DEH-0002', 'TND_E2E_UNGOVERNED', 'PRJ_E2E_UNGOVERNED',
     'BID_E2E_UNGOVERNED', 'ORG-E2E-CONTRACTOR', 200000000, repeat('0', 64),
     'USR-SEED-DEHYARI-ADMIN-B', at, 'DRAFT', at, 'SYSTEM', 'EVT_E2E_UNGOVERNED', at, 'SYSTEM',
     'e2e-fixture', at);
END
$fixture$;

COMMIT;
