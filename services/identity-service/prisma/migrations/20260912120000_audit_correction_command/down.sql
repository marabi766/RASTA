-- Reverses 20260912120000_audit_correction_command.
--
-- Destructive for replay protection: the table is the only record of which
-- `(actor, Idempotency-Key)` pairs have already been accepted, so after a
-- rollback a retry of an in-flight correction mints a second correction record
-- instead of replaying the first. The corrections themselves are unaffected --
-- they are evidence in audit-service, reached only through Kafka -- and neither
-- `idempotency_key` nor `outbox_message` is touched.
DROP TABLE IF EXISTS "audit_correction_command";

-- Prisma will not re-apply a migration whose row is still in its ledger, so a
-- rollback that leaves this behind cannot be rolled forward again: the command
-- endpoint would then start without the table its transaction writes to.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260912120000_audit_correction_command';
