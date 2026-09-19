-- Reverse of `migration.sql`: the two outbox tables, then the
-- `_prisma_migrations` row so the forward migration can be re-applied.
--
-- Dropping the tables takes their indexes and check constraints with them, so
-- nothing else has to be named here. There are no foreign keys in either
-- direction: the outbox deliberately does not reference the domain tables, and
-- nothing references it — which is what makes a rollback this simple.
--
-- **What a rollback costs, stated plainly.** Any row still in `outbox_message`
-- is an event that was written and not yet published. Dropping the table
-- discards it. That is unavoidable in either direction and is why a rollback
-- should follow a drained relay: the events these rows carry are audit records
-- for reads and dismissals that really happened, and `audit-service` has no
-- other way to learn about them. Anything already published has left and is
-- unaffected.

DROP TABLE IF EXISTS "outbox_stream_sequence";
DROP TABLE IF EXISTS "outbox_message";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260919060000_notification_outbox';
