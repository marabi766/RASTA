-- `trg_ledger_account_identity_fixed` in the form PostgreSQL prints back (FU-308 B, MONEY).
--
-- ## Why
--
-- 20261104120000 wrote the trigger's condition as one row comparison:
--
--   WHEN ((OLD."id", …, OLD."currency") IS DISTINCT FROM (NEW."id", …, NEW."currency"))
--
-- PostgreSQL does not keep a row comparison. It keeps one `IS DISTINCT FROM` per column, joined
-- by OR two at a time, prints that with a parenthesis per pair, and reads its own print back as
-- one OR of five. So a restored database prints the trigger differently from the database it was
-- dumped from, and the restore drill's SOURCE/REF gate (D-068), which lets nothing but a CHECK
-- line differ, refuses the restore. The gate is right and stays as it is: the definition moves.
--
-- ## What changes
--
-- Nothing an UPDATE can tell. The condition below is the same five comparisons joined by the same
-- OR, written as PostgreSQL prints them, so the dump of a restore now equals the dump of its
-- source. `test/ledger-account-identity-restore-stable.int-spec.ts` holds both forms to every
-- combination of unchanged, changed, NULL to value, value to NULL and NULL to NULL over the five
-- columns, and to the round trip. The function the trigger calls is not touched.
--
-- `CREATE OR REPLACE TRIGGER`, not DROP and CREATE: the guard is never absent, whatever runs this
-- file. A trigger someone had disabled comes back enabled.
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE TRIGGER "trg_ledger_account_identity_fixed"
  BEFORE UPDATE ON "ledger_account"
  FOR EACH ROW
  WHEN (OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."organization_id" IS DISTINCT FROM NEW."organization_id"
     OR OLD."account_type" IS DISTINCT FROM NEW."account_type"
     OR OLD."purpose" IS DISTINCT FROM NEW."purpose"
     OR OLD."currency" IS DISTINCT FROM NEW."currency")
  EXECUTE FUNCTION reject_ledger_account_identity_change();
