-- One fresh contract for one live contract-command scenario (`e2e/contract-fixture.ts`).
--
-- Why rows and not routes: contract-service has no route that creates a contract — one
-- is drafted only by the system, consuming TENDER_AWARDED (ADR-068 § 3) — and reaching
-- that event live is the whole tender pipeline `tests/e2e/specs/contract/
-- 01-contract-lifecycle.e2e-spec.ts` runs. So each scenario writes **its own** contract,
-- with ids it chose for this attempt (a retry writes new ones and never meets the state
-- an earlier attempt left), as contract-service's own runtime role, through every check
-- its database keeps: the contract is inserted as a DRAFT, as `contract_guard` allows.
--
-- With `signed` on, it is then signed by both sides — the employer under the
-- `contract.signature` policy of `contract-statements.sql` (POL_E2E_SIGNATURE, its
-- ORGANIZATION_ADMIN), as `contract_signature_guard` demands — and moved DRAFT -> SIGNED,
-- exactly as `contract-statements.sql` signs its contract.
--
-- Variables (psql -v): id, employer, contractor, amount, signed (true|false).

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO "contract"
  ("id", "organization_id", "tender_id", "project_id", "winning_bid_id",
   "contractor_organization_id", "amount_minor", "matrix_digest", "awarded_by", "awarded_at",
   "status", "status_changed_at", "status_changed_by", "source_event_id", "created_at",
   "created_by", "created_correlation_id", "updated_at")
VALUES
  (:'id', :'employer', 'TND_' || :'id', 'PRJ_' || :'id', 'BID_' || :'id', :'contractor',
   :'amount'::bigint, repeat('0', 64), 'USR-E2E-AWARDER', now() - interval '1 hour', 'DRAFT',
   now() - interval '1 hour', 'SYSTEM', 'EVT_' || :'id', now() - interval '1 hour', 'SYSTEM',
   'e2e-fixture', now() - interval '1 hour');

\if :signed
INSERT INTO "contract_signature"
  ("id", "organization_id", "contract_id", "side", "signer_organization_id", "signed_by",
   "authority_role", "signed_at", "correlation_id", "policy_id", "policy_version")
VALUES
  ('SIG_C_' || :'id', :'employer', :'id', 'CONTRACTOR', :'contractor',
   'USR-E2E-CONTRACT-SIGNER', 'CONTRACTOR', now() - interval '50 minutes', 'e2e-fixture', NULL,
   NULL),
  ('SIG_E_' || :'id', :'employer', :'id', 'EMPLOYER', :'employer', 'USR-SEED-DEHYARI-ADMIN',
   'ORGANIZATION_ADMIN', now() - interval '40 minutes', 'e2e-fixture', 'POL_E2E_SIGNATURE', 1);

UPDATE "contract"
   SET "status" = 'SIGNED', "status_changed_at" = now() - interval '40 minutes',
       "status_changed_by" = 'USR-SEED-DEHYARI-ADMIN', "updated_at" = now() - interval '40 minutes',
       "version" = 2
 WHERE "organization_id" = :'employer' AND "id" = :'id';
\endif

COMMIT;
