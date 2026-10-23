-- The orders the return scenarios act on (`e2e/returns.spec.ts`).
--
-- Why rows and not routes: a return is asked only of a COMPLETED order, and an
-- order completes only when economic-service settles it — the saga this job runs
-- without (`MARKETPLACE_TEMPORAL_ENABLED=false`), and money no browser test may
-- start moving (`e2e/README.md`). The return screens need an order that is
-- already completed; nothing about how it got there is under test here.
--
-- So this writes, as marketplace-service's own runtime role and through every
-- CHECK its `order` and `order_line` tables keep, the two orders the service
-- would have ended with — ORG-DEH-0001 buying from ORG-DEH-0002, each line's
-- total its price times its quantity:
--
--   * a product of ORG-DEH-0002 with a ULID id, PRD_01JE2ERETVRNS00000000000P1
--     (inventory-service names a returned product by `PRD_<ULID>`, which the
--     seed's `PRD_SEED_*` ids are not), offered by it in a DRAFT offer nobody
--     else lists, at 5 000 000 a tonne;
--   * ORD_01JE2ERETVRNS0000000000001, completed two days ago — inside the
--     return window the job configures (MARKETPLACE_RETURN_WINDOW_DAYS=30, a
--     value for this throwaway stack only: Q-132 leaves the real one open):
--     10 tonnes of that gravel and 20 of the seed's cement (OFR_SEED_CEMENT_D2);
--   * ORD_01JE2ERETVRNS0000000000002, completed four hundred days ago — past
--     any window that setting allows: 10 tonnes of gravel.
--
-- The economic transaction and settlement ids a COMPLETED order must name
-- (`ck_order_held_has_transaction`, `ck_order_completed_has_settlement`) exist
-- only here: no scenario reads them, and economic-service holds nothing for
-- them. Run once per database; a second run changes nothing.

BEGIN;

INSERT INTO "product"
  ("id", "organization_id", "sku", "name", "category", "kind", "unit", "status", "search_text",
   "created_by", "updated_at")
VALUES
  ('PRD_01JE2ERETVRNS00000000000P1', 'ORG-DEH-0002', 'E2E-RETURNS-GRAVEL', 'شن شسته — آزمون بازگشت',
   'مصالح', 'GOOD', 'تن', 'ACTIVE', 'شن شسته آزمون بازگشت e2e-returns-gravel',
   'USR-SEED-DEHYARI2-ADMIN', now() - interval '500 days')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "offer"
  ("id", "organization_id", "product_id", "unit_price_minor", "currency", "available_quantity",
   "lead_time_days", "minimum_quantity", "status", "version", "published_at", "created_by",
   "updated_at")
VALUES
  ('OFR_E2E_RETURNS_GRAVEL', 'ORG-DEH-0002', 'PRD_01JE2ERETVRNS00000000000P1', 5000000, 'IRR', 0,
   3, 1, 'DRAFT', 1, NULL, 'USR-SEED-DEHYARI2-ADMIN', now() - interval '500 days')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "order"
  ("id", "organization_id", "supplier_organization_id", "placed_by", "status",
   "total_amount_minor", "currency", "economic_transaction_id", "economic_settlement_id",
   "idempotency_key", "correlation_id", "confirmed_at", "fulfilled_at",
   "receipt_confirmed_at", "receipt_confirmed_by", "completed_at", "created_at",
   "created_by", "updated_at")
VALUES
  ('ORD_01JE2ERETVRNS0000000000001', 'ORG-DEH-0001', 'ORG-DEH-0002', 'USR-SEED-DEHYARI-ADMIN',
   'COMPLETED', 107000000, 'IRR', 'TXN_E2E_RETURNS_RECENT', 'STL_E2E_RETURNS_RECENT',
   'e2e-returns-recent', 'e2e-fixture', now() - interval '6 days', now() - interval '4 days',
   now() - interval '3 days', 'USR-SEED-DEHYARI-ADMIN', now() - interval '2 days',
   now() - interval '7 days', 'USR-SEED-DEHYARI-ADMIN', now() - interval '2 days'),
  ('ORD_01JE2ERETVRNS0000000000002', 'ORG-DEH-0001', 'ORG-DEH-0002', 'USR-SEED-DEHYARI-ADMIN',
   'COMPLETED', 50000000, 'IRR', 'TXN_E2E_RETURNS_OLD', 'STL_E2E_RETURNS_OLD',
   'e2e-returns-old', 'e2e-fixture', now() - interval '404 days', now() - interval '402 days',
   now() - interval '401 days', 'USR-SEED-DEHYARI-ADMIN', now() - interval '400 days',
   now() - interval '405 days', 'USR-SEED-DEHYARI-ADMIN', now() - interval '400 days')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "order_line"
  ("id", "organization_id", "order_id", "offer_id", "product_id", "unit_price_minor",
   "quantity", "line_total_minor", "currency", "offer_version", "product_name")
SELECT line.id, 'ORG-DEH-0001', line.order_id, offer."id", offer."product_id",
       offer."unit_price_minor", line.quantity, offer."unit_price_minor" * line.quantity,
       offer."currency", offer."version", product."name"
FROM (VALUES
  ('OLN_01JE2ERETVRNS00000000000A1', 'ORD_01JE2ERETVRNS0000000000001', 'OFR_E2E_RETURNS_GRAVEL', 10),
  ('OLN_01JE2ERETVRNS00000000000B1', 'ORD_01JE2ERETVRNS0000000000001', 'OFR_SEED_CEMENT_D2', 20),
  ('OLN_01JE2ERETVRNS00000000000A2', 'ORD_01JE2ERETVRNS0000000000002', 'OFR_E2E_RETURNS_GRAVEL', 10)
) AS line(id, order_id, offer_id, quantity)
JOIN "offer" offer ON offer."id" = line.offer_id
JOIN "product" product ON product."id" = offer."product_id"
ON CONFLICT ("id") DO NOTHING;

COMMIT;
