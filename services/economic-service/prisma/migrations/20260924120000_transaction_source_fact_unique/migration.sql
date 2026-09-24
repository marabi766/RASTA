-- One obligation per business fact, per payer.
--
-- recordAuthorisedObligation was check-then-insert on (source_type,
-- source_reference) with nothing underneath it but a non-unique index. Two
-- MAINTENANCE_APPROVED events carrying the same requestId under different
-- eventIds (a producer re-emit, or two consumer instances) could both miss the
-- check and both insert. The result was two PENDING_SETTLEMENT obligations,
-- and both would settle. POST /v1/transactions with a different
-- Idempotency-Key reached the same insert.
--
-- Why the key includes organization_id (the payer). A caller of
-- POST /v1/transactions chooses source_type and source_reference freely. On a
-- platform-wide key, tenant A could record MAINTENANCE_REQUEST/<B's request id>
-- first. B's real approval would then find A's row and record nothing, and the
-- 409 would also tell A that B's identifier exists. The duplicates that cost
-- money are the ones charged to the same payer twice, and this key refuses
-- exactly those.
--
-- Partial: rows with no source (a plain HTTP obligation) are not facts from
-- another service and are unconstrained, as before.
--
-- Populated databases: an existing duplicate would make the index build fail
-- with a bare 23505 part-way through a deploy. Checked first instead, and
-- refused loudly, with nothing deleted: which of two settled obligations for
-- one repair is the real one is a financial decision for a person, not for a
-- migration. The HINT gives the query that lists them.
DO $$
DECLARE
  duplicate_facts integer;
BEGIN
  SELECT count(*) INTO duplicate_facts
    FROM (
      SELECT 1
        FROM "transaction"
       WHERE "source_type" IS NOT NULL
         AND "source_reference" IS NOT NULL
       GROUP BY "organization_id", "source_type", "source_reference"
      HAVING count(*) > 1
    ) AS duplicates;

  IF duplicate_facts > 0 THEN
    RAISE EXCEPTION
      'transaction: % source fact(s) are recorded more than once for the same payer; refusing to add ux_transaction_source_fact',
      duplicate_facts
      USING HINT = 'List them with: SELECT organization_id, source_type, source_reference, array_agg(id ORDER BY created_at) FROM "transaction" WHERE source_type IS NOT NULL AND source_reference IS NOT NULL GROUP BY 1, 2, 3 HAVING count(*) > 1; resolve each by a recorded financial decision (refund or cancel the extra obligation), never by DELETE.';
  END IF;
END $$;

SET LOCAL lock_timeout = '3s';

CREATE UNIQUE INDEX IF NOT EXISTS "ux_transaction_source_fact"
    ON "transaction" ("organization_id", "source_type", "source_reference")
 WHERE "source_type" IS NOT NULL
   AND "source_reference" IS NOT NULL;
