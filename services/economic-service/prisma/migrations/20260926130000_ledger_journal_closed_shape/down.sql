-- Reverses 20260926130000_ledger_journal_closed_shape.
--
-- Removes the two guards and nothing else: every journal and entry written
-- while they existed stays as it is. Afterwards an empty journal, or an
-- append to a posted one, is again refused only by the application, which
-- is the state before this migration.
SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS trg_ledger_entry_open_journal ON "ledger_entry";
DROP FUNCTION IF EXISTS assert_entry_joins_open_journal();

DROP TRIGGER IF EXISTS trg_journal_has_entries ON "journal";
DROP FUNCTION IF EXISTS assert_journal_has_entries();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926130000_ledger_journal_closed_shape';
