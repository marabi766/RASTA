-- Source types only their owner records (src/transaction/recorded-sources.ts).
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
-- - ORDER/<order id>: the order saga's own creation got 409, it looked the
--   obligation up, found the caller's row — 1 rial to an accomplice — and
--   authorised and settled it as the order's payment.
--
-- The API now refuses the first two (and STATEMENT) to every caller, and
-- ORDER to everyone but marketplace-service (400 VALIDATION_FAILED). These
-- CHECKs hold the same line at the database:
--
-- - MAINTENANCE_REQUEST: a MAINTENANCE_SERVICE obligation to a payee, written
--   by economic-service from an event (a causation id, no Idempotency-Key —
--   POST /v1/transactions always stores one).
-- - PAYMENT_INTENT: a WALLET_TOP_UP with no payee and no Idempotency-Key — a
--   type POST /v1/transactions never accepts.
-- - ORDER (ck_transaction_order_source): a MARKETPLACE_ORDER obligation to a
--   payee, written over the API (an Idempotency-Key) by a service. A row a
--   person writes names that person in created_by; a service's names
--   economic-service. Which service signed is the API's to check — the
--   database does not hold it.
--
-- STATEMENT is reserved at the API as well; its database guard is
-- ck_transaction_statement_obligation (CON-003 PR 6b).
--
-- Populated databases (review of #334 round 1, F2). A row under one of these
-- types is accepted only where its provenance is provable from the database
-- itself, as this release, any earlier one, or this one rolled back by
-- down.sql (which keeps every row) and applied again writes it:
--
-- - MAINTENANCE_REQUEST: the writer's shape, and its causation_id is an event
--   SettlementAuthorityConsumer marked processed in the same transaction
--   (processed_event under 'economic-service.settlement-authority', which
--   nothing deletes and POST /v1/transactions never writes).
-- - PAYMENT_INTENT: the writer's shape, and the payment intent it names
--   (same organization) records this very row as its top-up
--   (payment_intent.transaction_id, written by the capture in the same
--   transaction, never over the API).
-- - ORDER: the shape the CHECK holds — written over the API by a service.
--
-- Anything else was written by a caller the previous rules let through. It is
-- not the owner's fact, and it holds the key the owner needs. Counted and
-- refused loudly, with nothing changed; the HINT names the correction that
-- works. Cancelling or refunding such a row is the financial decision about
-- it, but it does not free the key — the row keeps its source fields — so the
-- correction also takes it off the reserved type, to <type>_UNCONFIRMED, with
-- every financial fact on it kept as it is.
DO $$
DECLARE
  offending integer;
BEGIN
  SELECT count(*) INTO offending
    FROM "transaction" t
   WHERE (t."source_type" = 'MAINTENANCE_REQUEST'
          AND NOT ("transaction_type" = 'MAINTENANCE_SERVICE'
                   AND "source_reference" IS NOT NULL
                   AND "counterparty_organization_id" IS NOT NULL
                   AND "idempotency_key" IS NULL
                   AND "causation_id" IS NOT NULL
                   AND "created_by" = 'economic-service'
                   AND EXISTS (SELECT 1 FROM "processed_event" p
                                WHERE p."event_id" = t."causation_id"
                                  AND p."consumer_name" = 'economic-service.settlement-authority')))
      OR (t."source_type" = 'PAYMENT_INTENT'
          AND NOT ("transaction_type" = 'WALLET_TOP_UP'
                   AND "source_reference" IS NOT NULL
                   AND "counterparty_organization_id" IS NULL
                   AND "idempotency_key" IS NULL
                   AND EXISTS (SELECT 1 FROM "payment_intent" i
                                WHERE i."id" = t."source_reference"
                                  AND i."organization_id" = t."organization_id"
                                  AND i."transaction_id" = t."id")))
      OR (t."source_type" = 'ORDER'
          AND NOT ("transaction_type" = 'MARKETPLACE_ORDER'
                   AND "source_reference" IS NOT NULL
                   AND "counterparty_organization_id" IS NOT NULL
                   AND "idempotency_key" IS NOT NULL
                   AND "created_by" = 'economic-service'));

  IF offending > 0 THEN
    RAISE EXCEPTION
      'transaction: % row(s) claim source_type MAINTENANCE_REQUEST, PAYMENT_INTENT or ORDER without being recorded by its owner; refusing to reserve them',
      offending
      USING HINT = 'List them with: SELECT id, organization_id, source_type, source_reference, transaction_type, status, gross_amount_minor, counterparty_organization_id, created_by, idempotency_key, causation_id FROM "transaction" t WHERE (t.source_type = ''MAINTENANCE_REQUEST'' AND NOT (t.transaction_type = ''MAINTENANCE_SERVICE'' AND t.source_reference IS NOT NULL AND t.counterparty_organization_id IS NOT NULL AND t.idempotency_key IS NULL AND t.causation_id IS NOT NULL AND t.created_by = ''economic-service'' AND EXISTS (SELECT 1 FROM processed_event p WHERE p.event_id = t.causation_id AND p.consumer_name = ''economic-service.settlement-authority''))) OR (t.source_type = ''PAYMENT_INTENT'' AND NOT (t.transaction_type = ''WALLET_TOP_UP'' AND t.source_reference IS NOT NULL AND t.counterparty_organization_id IS NULL AND t.idempotency_key IS NULL AND EXISTS (SELECT 1 FROM payment_intent i WHERE i.id = t.source_reference AND i.organization_id = t.organization_id AND i.transaction_id = t.id))) OR (t.source_type = ''ORDER'' AND NOT (t.transaction_type = ''MARKETPLACE_ORDER'' AND t.source_reference IS NOT NULL AND t.counterparty_organization_id IS NOT NULL AND t.idempotency_key IS NOT NULL AND t.created_by = ''economic-service'')); none is its owner''s fact. For each, record the financial decision on it under the release now running (cancel or refund it if nobody owes it), then take it off the reserved type by a reviewed data correction recorded with that decision: UPDATE "transaction" SET source_type = source_type || ''_UNCONFIRMED'' WHERE id = <id>. Never DELETE it.';
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

ALTER TABLE "transaction"
  ADD CONSTRAINT "ck_transaction_order_source" CHECK (
    "source_type" IS DISTINCT FROM 'ORDER'
    OR (
      "transaction_type" = 'MARKETPLACE_ORDER'
      AND "source_reference" IS NOT NULL
      AND "counterparty_organization_id" IS NOT NULL
      AND "idempotency_key" IS NOT NULL
      AND "created_by" = 'economic-service'
    )
  );
