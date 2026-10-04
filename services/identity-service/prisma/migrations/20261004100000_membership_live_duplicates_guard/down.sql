-- Reverses 20261004100000_membership_live_duplicates_guard: a check, and the
-- drop of an INVALID index that enforced nothing — neither leaves anything to
-- undo, so only its ledger row goes. Also the recovery step after a failed
-- build: removing this row makes the next deploy run the check again
-- (docs/runbooks/database-bootstrap.md#identity-one-live-membership).
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261004100000_membership_live_duplicates_guard';
