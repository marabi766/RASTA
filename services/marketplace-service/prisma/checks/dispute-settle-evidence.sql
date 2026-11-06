-- Read-only (D-083, marketplace audit F1; docs/runbooks/marketplace-receipt-evidence.md).
--
-- Finds the rows the old dispute SETTLE could leave behind, and the disputes the new one refuses:
--   RECEIPT_CONFIRMED_WITHOUT_RECEIPT  an order RECEIPT_CONFIRMED with nobody's receipt recorded —
--                                      what SETTLE wrote for a dispute raised before receipt. Its
--                                      saga cannot settle it (ck_order_settled_after_receipt).
--   OPEN_DISPUTE_ORIGIN_UNKNOWN        an open dispute raised before migration
--                                      20261103130000_order_dispute_origin whose origin the history
--                                      did not state with certainty: SETTLE is refused for it
--                                      (DISPUTE_ORIGIN_UNKNOWN), REFUND still decides it.
-- Identifiers only — no amount, reason or party text. Nothing is changed; no row is repaired.
SELECT 'RECEIPT_CONFIRMED_WITHOUT_RECEIPT' AS finding, o."id" AS order_id, NULL::text AS dispute_id,
       o."updated_at" AS since
  FROM "order" AS o
 WHERE o."status" = 'RECEIPT_CONFIRMED'
   AND (o."receipt_confirmed_at" IS NULL OR o."receipt_confirmed_by" IS NULL)
UNION ALL
SELECT 'OPEN_DISPUTE_ORIGIN_UNKNOWN', d."order_id", d."id", d."raised_at"
  FROM "order_dispute" AS d
 WHERE d."status" = 'OPEN' AND d."raised_from_status" IS NULL
 ORDER BY 1, 2
