-- Reverses 20260911120000_security_event_outbox (ADR-053 § 4, AUD-004 Phase C1).
--
-- Roll the code back first. A refusal filter that cannot find its table fails
-- its insert, counts the failure and still returns the original `403` — the
-- capture is best-effort by design — but the flusher would log a failed claim
-- on every poll until it is gone too.
--
-- Destructive for undelivered evidence: any row not yet published to
-- `rasta.audit.trail.v1` is dropped with the table. Drain first
-- (`published_at IS NULL` count reaching zero) if those refusals matter.

SET LOCAL lock_timeout = '3s';

-- Indexes and constraints go with the table.
DROP TABLE IF EXISTS "security_event_outbox";

-- Prisma will not re-apply a migration whose row is still in its ledger, so a
-- rollback that leaves this behind cannot be rolled forward again.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260911120000_security_event_outbox';
