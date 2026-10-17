-- Source types economic-service records itself (src/transaction/recorded-sources.ts).
--
-- ux_transaction_source_fact makes (organization_id, source_type,
-- source_reference) unique, and each recorder finds an existing row under its
-- key before writing. POST /v1/transactions let its caller choose source_type
-- freely, so a row it wrote first under one of these keys held it:
--
-- - MAINTENANCE_REQUEST/<request id>: the real MAINTENANCE_APPROVED found that
--   row — with the caller's amount and payee — and recorded nothing (ADR-032,
--   ADR-061 § 4: the obligation is built from maintenance-service's record).
-- - PAYMENT_INTENT/<intent id>: every capture of that intent failed on the
--   unique key, so money captured at the provider was never credited, and the
--   intent read as disagreeing with its top-up.
--
-- The API now refuses those source types to every caller (400
-- VALIDATION_FAILED). This CHECK holds the same line at the database: such a
-- row is exactly what its one writer records, which no HTTP row can be.
--
-- - MAINTENANCE_REQUEST: a MAINTENANCE_SERVICE obligation to a payee, written
--   by economic-service from an event (a causation id, no Idempotency-Key —
--   POST /v1/transactions always stores one).
-- - PAYMENT_INTENT: a WALLET_TOP_UP with no payee and no Idempotency-Key — a
--   type POST /v1/transactions never accepts.
--
-- STATEMENT is reserved at the API as well; its database guard is
-- ck_transaction_statement_obligation (CON-003 PR 6b).
--
-- Populated databases: both writers have always written rows of exactly this
-- shape, so the only rows this can find are ones written over HTTP. They are
-- counted first and refused loudly, with nothing changed: whether such a row
-- is an obligation someone owes is a financial decision for a person.
DO $$
DECLARE
  offending integer;
BEGIN
  SELECT count(*) INTO offending
    FROM "transaction"
   WHERE ("source_type" = 'MAINTENANCE_REQUEST'
          AND NOT ("transaction_type" = 'MAINTENANCE_SERVICE'
                   AND "source_reference" IS NOT NULL
                   AND "counterparty_organization_id" IS NOT NULL
                   AND "idempotency_key" IS NULL
                   AND "causation_id" IS NOT NULL
                   AND "created_by" = 'economic-service'))
      OR ("source_type" = 'PAYMENT_INTENT'
          AND NOT ("transaction_type" = 'WALLET_TOP_UP'
                   AND "source_reference" IS NOT NULL
                   AND "counterparty_organization_id" IS NULL
                   AND "idempotency_key" IS NULL));

  IF offending > 0 THEN
    RAISE EXCEPTION
      'transaction: % row(s) claim source_type MAINTENANCE_REQUEST or PAYMENT_INTENT without being recorded by economic-service; refusing to reserve them',
      offending
      USING HINT = 'List them with: SELECT id, organization_id, source_type, source_reference, transaction_type, status, created_by, idempotency_key, causation_id FROM "transaction" WHERE source_type IN (''MAINTENANCE_REQUEST'', ''PAYMENT_INTENT'') AND idempotency_key IS NOT NULL (an HTTP row always carries its Idempotency-Key); resolve each by a recorded financial decision (cancel or refund it), never by DELETE or UPDATE.';
  END IF;
END $$;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "transaction"
  ADD CONSTRAINT "ck_transaction_recorded_source" CHECK (
    (
      "source_type" IS DISTINCT FROM 'MAINTENANCE_REQUEST'
      OR (
        "transaction_type" = 'MAINTENANCE_SERVICE'
        AND "source_reference" IS NOT NULL
        AND "counterparty_organization_id" IS NOT NULL
        AND "idempotency_key" IS NULL
        AND "causation_id" IS NOT NULL
        AND "created_by" = 'economic-service'
      )
    )
    AND (
      "source_type" IS DISTINCT FROM 'PAYMENT_INTENT'
      OR (
        "transaction_type" = 'WALLET_TOP_UP'
        AND "source_reference" IS NOT NULL
        AND "counterparty_organization_id" IS NULL
        AND "idempotency_key" IS NULL
      )
    )
  );
