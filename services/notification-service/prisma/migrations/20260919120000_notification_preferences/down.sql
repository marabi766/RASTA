-- Reverse of `migration.sql`: the table, then its enum, then the
-- `_prisma_migrations` row so the forward migration can be re-applied.
--
-- Dropping the table takes its indexes and the check constraint with it. The
-- enum is dropped separately and *after*, because a type cannot be dropped
-- while a column still uses it — the ordering is the whole reason a hand-
-- written down script exists rather than a guess.
--
-- **What a rollback costs.** Every stored preference is discarded, and the
-- resolver falls back to the configured channel defaults for everyone. Nothing
-- is delivered that should not be: the defaults are the same ones a user who
-- never expressed a preference already gets. What is lost is the record that
-- somebody chose otherwise, which is a real loss and not a silent one.

DROP TABLE IF EXISTS "notification_preference";
DROP TYPE IF EXISTS "preference_scope";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260919120000_notification_preferences';
