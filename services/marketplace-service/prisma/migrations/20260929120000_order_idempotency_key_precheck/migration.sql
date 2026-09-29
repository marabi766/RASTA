-- Review of #141: an Idempotency-Key places at most one order per organization.
--
-- The next migration builds uq_order_org_idempotency_key CONCURRENTLY. A build
-- over duplicate rows fails with a bare unique violation and leaves an INVALID
-- index behind; this check fails first, and says what to do. It is its own
-- migration because CONCURRENTLY must be the only statement in its script
-- (a multi-statement script runs as one implicit transaction).
--
-- It changes nothing: no row, no object.
--
-- IF IT FAILS (P3018, "… pairs hold more than one order …"), deploying again
-- is not enough: Prisma keeps this migration's failed record, and every
-- deploy is refused with P3009 until it is resolved. In order:
--   1. list the duplicates (query in the HINT below);
--   2. re-key all but the earliest order of each pair — never delete one;
--   3. prisma migrate resolve --rolled-back 20260929120000_order_idempotency_key_precheck
--   4. deploy.
-- Exact commands: docs/runbooks/database-bootstrap.md#marketplace-order-key-index
-- (sequence verified on a throwaway schema in PR #141).

DO $$
DECLARE
    duplicated INT;
BEGIN
    SELECT count(*) INTO duplicated
      FROM (
        SELECT 1
          FROM "order"
         GROUP BY "organization_id", "idempotency_key"
        HAVING count(*) > 1
      ) AS pairs;

    IF duplicated > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = format(
                '%s (organization_id, idempotency_key) pairs hold more than one order, '
                'so uq_order_org_idempotency_key cannot be built',
                duplicated
            ),
            HINT = 'List them with: SELECT organization_id, idempotency_key, array_agg(id) '
                   'FROM "order" GROUP BY 1, 2 HAVING count(*) > 1; — each is an order placed '
                   'twice under one key. Re-key all but the earliest (never delete an order), '
                   'then prisma migrate resolve --rolled-back '
                   '20260929120000_order_idempotency_key_precheck, then deploy. Runbook: '
                   'docs/runbooks/database-bootstrap.md#marketplace-order-key-index';
    END IF;
END
$$;
