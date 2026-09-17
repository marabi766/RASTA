-- Reverse of `migration.sql`: the trigger, then the function it calls, then
-- the `_prisma_migrations` row so the forward migration can be re-applied.
-- Nothing in the data changes; the rule that read state cannot be rewound is
-- simply no longer enforced by the database.

DROP TRIGGER IF EXISTS "in_app_notification_state_write_once" ON "in_app_notification";
DROP FUNCTION IF EXISTS refuse_in_app_state_regression();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260917150000_in_app_read_state_write_once';
