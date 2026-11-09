-- Reverse of `migration.sql` (20261109200000_ledger_account_identity_restore_stable).
--
-- Gives back, byte for byte, the trigger of 20261104120000: the same condition as one row
-- comparison. It refuses and allows the same updates, so nothing is rewritten and nothing is
-- refused; the restore drill's SOURCE/REF gate refuses a restore again until this is re-applied.
--
-- Before 20261104120000's own down, never after it: that one drops the trigger in whichever form
-- it stands, and a re-deploy would then bring the row comparison back and skip this migration.
BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE TRIGGER "trg_ledger_account_identity_fixed"
  BEFORE UPDATE ON "ledger_account"
  FOR EACH ROW
  WHEN ((OLD."id", OLD."organization_id", OLD."account_type", OLD."purpose", OLD."currency")
        IS DISTINCT FROM
        (NEW."id", NEW."organization_id", NEW."account_type", NEW."purpose", NEW."currency"))
  EXECUTE FUNCTION reject_ledger_account_identity_change();

DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20261109200000_ledger_account_identity_restore_stable';

COMMIT;
