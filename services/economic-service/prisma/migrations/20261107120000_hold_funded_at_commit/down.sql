-- Reverse of `migration.sql` (20261107120000_hold_funded_at_commit).
--
-- Gives 20261106130000's `wallet_hold_funded` back, byte for byte, and drops the three triggers and
-- their functions. Nothing was rewritten going up, so nothing is put back. The service asks the
-- predicate by name and works on either body, so the release need not be rolled back first.
BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "wallet_hold", "journal", "ledger_entry" IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION wallet_hold_funded(subject TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "wallet_hold" h
      JOIN "wallet" w ON w."id" = h."wallet_id"
                     AND w."organization_id" = h."organization_id"
                     AND w."currency" = h."currency"
      JOIN "journal" j ON j."id" = h."placed_journal_id"
                      AND j."journal_type" = 'FUNDS_HELD'
                      AND j."organization_id" = h."organization_id"
     WHERE h."id" = subject
       AND CASE h."reference_type"
             WHEN 'TRANSACTION' THEN j."transaction_id" = h."reference"
             WHEN 'PAYMENT_REFUND' THEN EXISTS (
               SELECT 1 FROM "payment_intent" p
                WHERE p."id" = h."reference"
                  AND p."wallet_id" = h."wallet_id"
                  AND p."transaction_id" = j."transaction_id"
                  AND p."amount_minor" = h."amount_minor"
                  AND p."currency" = h."currency")
             ELSE FALSE
           END
       AND NOT EXISTS (SELECT 1 FROM "journal" r WHERE r."reverses_id" = j."id")
       -- A leg's organization and currency are its account's (`fk_ledger_entry_account_identity`).
       AND (SELECT SUM(CASE e."direction" WHEN 'CREDIT' THEN e."amount_minor" ELSE -e."amount_minor" END)
              FROM "ledger_entry" e
              JOIN "ledger_account" a ON a."id" = e."account_id"
             WHERE e."journal_id" = j."id"
               AND a."purpose" = 'ESCROW'
               AND a."organization_id" = h."organization_id"
               AND a."currency" = h."currency") = h."amount_minor");
$$ LANGUAGE sql STABLE;

DROP TRIGGER "trg_journal_hold_funding_final" ON "journal";
DROP FUNCTION reject_hold_journal_reversal();
DROP TRIGGER "trg_ledger_entry_hold_journal_closed" ON "ledger_entry";
DROP FUNCTION reject_hold_journal_leg();
DROP TRIGGER "trg_wallet_hold_funded_at_commit" ON "wallet_hold";
DROP FUNCTION assert_wallet_hold_funded_at_commit();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261107120000_hold_funded_at_commit';

COMMIT;
