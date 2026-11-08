-- D-156: an order line's price is one its offer published at the version the line names.
--
-- The next migration adds fk_order_line_price_history: every order_line's (offer_id,
-- offer_version, unit_price_minor, currency) must be a row of offer_price_history. Validated over
-- a line that no history row describes, it fails with a bare foreign-key violation; this check
-- fails first, and says what to do. It changes nothing: no row, no object.
--
-- A line it names is NEVER fixed by relabelling the line or by inventing a history row: either
-- would turn "we cannot prove what this order agreed to" into a claim that we can. Each one is a
-- finding for whoever owns the order (the buyer and the supplier were told a price; which one?).
--
-- IF IT FAILS (P3018, "… order lines name an offer price no history row records …"), deploying
-- again is not enough: Prisma keeps this migration's failed record and refuses every deploy with
-- P3009 until it is resolved. List the lines (query in the HINT), settle each with its owner
-- from the order's own evidence (ORDER_CREATED in the outbox/event log carries the line's
-- unitPriceMinor and offerVersion), then
--   prisma migrate resolve --rolled-back 20261108120000_order_line_price_history_precheck
-- and deploy.

DO $$
DECLARE
    unproven BIGINT;
BEGIN
    SELECT count(*) INTO unproven
      FROM "order_line" l
     WHERE NOT EXISTS (
       SELECT 1
         FROM "offer_price_history" h
        WHERE h."offer_id" = l."offer_id"
          AND h."version" = l."offer_version"
          AND h."unit_price_minor" = l."unit_price_minor"
          AND h."currency" = l."currency"
     );

    IF unproven > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = format(
                '%s order lines name an offer price no history row records, '
                'so fk_order_line_price_history cannot be validated',
                unproven
            ),
            HINT = 'List them with: SELECT l.id, l.order_id, l.offer_id, l.offer_version '
                   'FROM order_line l WHERE NOT EXISTS (SELECT 1 FROM offer_price_history h '
                   'WHERE h.offer_id = l.offer_id AND h.version = l.offer_version AND '
                   'h.unit_price_minor = l.unit_price_minor AND h.currency = l.currency); — never '
                   'relabel a line or invent a history row. Settle each with its owner, then '
                   'prisma migrate resolve --rolled-back '
                   '20261108120000_order_line_price_history_precheck, then deploy.';
    END IF;
END
$$;
