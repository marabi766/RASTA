-- Reverses 20261004100000_membership_live_duplicates_guard: a read-only check,
-- so only its ledger row goes.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261004100000_membership_live_duplicates_guard';
