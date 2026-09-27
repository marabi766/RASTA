-- A journal is posted whole, once (economic batch 2, item f).
--
-- trg_journal_balanced fires on ledger_entry INSERT only, so two shapes passed
-- it:
--
--   1. A journal with no entries at all. Nothing inserted a ledger_entry, so
--      nothing was checked, and an empty journal committed.
--   2. A balanced pair appended to a journal posted in an earlier
--      transaction. The pair balances, so the journal still does, and a
--      closed record silently grew new lines. A correction is a new journal
--      (a reversal), never an amendment (AGENTS.md A-06).
--
-- Two triggers close them:
--
--   trg_journal_has_entries        deferred to COMMIT, on journal INSERT:
--                                  the journal has at least two entries.
--   trg_ledger_entry_open_journal  on ledger_entry INSERT: the journal was
--                                  inserted by this same transaction.
--
-- "This same transaction" is read from the journal row's xmin against the
-- current transaction id, not from anything a session can set, so it cannot
-- be spoofed from SQL. It fails closed: a journal inserted inside a savepoint
-- carries the subtransaction's id and its entries are refused. Nothing in this
-- service posts a journal inside a savepoint, and a false refusal there is a
-- visible error, not a silent append.
--
-- Populated databases: both triggers fire on INSERT only, so every existing
-- row stays exactly as valid as it was, and nothing here rewrites or deletes
-- ledger history (it cannot: the ledger is append-only). A journal that was
-- already committed empty is reported as a WARNING, not refused: it cannot be
-- deleted, it moves no balance, and refusing would block every later deploy
-- over a row nobody may change. An earlier append cannot be told apart from a
-- journal posted whole, and is not guessed at.
DO $$
DECLARE
  empty_journals integer;
BEGIN
  SELECT count(*) INTO empty_journals
    FROM "journal" j
   WHERE NOT EXISTS (SELECT 1 FROM "ledger_entry" e WHERE e."journal_id" = j."id");

  IF empty_journals > 0 THEN
    RAISE WARNING
      'journal: % journal(s) were committed with no ledger entries before trg_journal_has_entries existed; they are left as they are',
      empty_journals
      USING HINT = 'List them with: SELECT j.id, j.organization_id, j.journal_type, j.posted_at FROM journal j WHERE NOT EXISTS (SELECT 1 FROM ledger_entry e WHERE e.journal_id = j.id);';
  END IF;
END $$;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION assert_journal_has_entries() RETURNS TRIGGER AS $$
DECLARE
  leg_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO leg_count FROM "ledger_entry" WHERE "journal_id" = NEW."id";

  IF leg_count < 2 THEN
    RAISE EXCEPTION
      'journal % has % ledger entries; a posted journal needs at least two',
      NEW."id", leg_count
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_journal_has_entries
  AFTER INSERT ON "journal"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_has_entries();

CREATE OR REPLACE FUNCTION assert_entry_joins_open_journal() RETURNS TRIGGER AS $$
DECLARE
  opened_by TEXT;
BEGIN
  -- xmin is the 32-bit id of the transaction that inserted the row;
  -- txid_current() is the epoch-extended id of this one. Equal low 32 bits
  -- means this transaction inserted the journal. An uncommitted journal of
  -- another transaction is invisible here, and a missing one reads NULL:
  -- both are refused.
  SELECT j.xmin::text INTO opened_by FROM "journal" j WHERE j."id" = NEW."journal_id";

  IF opened_by IS DISTINCT FROM (txid_current() % 4294967296)::text THEN
    RAISE EXCEPTION
      'journal % was not opened in this transaction; a posted journal is closed. Post a new journal, or a reversal, instead of appending to it.',
      NEW."journal_id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_entry_open_journal
  BEFORE INSERT ON "ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION assert_entry_joins_open_journal();
