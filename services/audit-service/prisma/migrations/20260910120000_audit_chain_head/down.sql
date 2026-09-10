-- Reverses the AUD-003 chain head, and nothing else.
--
-- `audit_event` is not touched beyond dropping the index this migration added.
-- Its append-only privileges and both of its triggers belong to
-- `20260908120000_init_audit` and stay exactly as they are: a rollback that
-- weakened the append-only guarantee, even for the seconds between a down and
-- the next up, would be a window in which the evidence store is mutable. There
-- is no such window here.
--
-- `record_hash` and `previous_hash` are left populated on the rows that carry
-- them. They are columns of the evidence table, they were written by the
-- transactions that wrote those rows, and the store cannot update them --
-- clearing them would need the UPDATE privilege the design exists to withhold,
-- and it would destroy evidence to undo a schema change. After a rollback those
-- values are simply unverifiable until the head table returns, which is the
-- same honest state as a pre-AUD-003 row and is what the runbook describes.
--
-- The cost of rolling back is therefore bounded and recoverable: the next
-- record in each (organization, month) starts a new segment, exactly as the
-- first post-migration record did.
--
-- ## The segment start goes with the table, and cannot go anywhere else
--
-- `first_sequence_no` is a column of `audit_chain_head`, so `DROP TABLE` takes
-- it and its two CHECK constraints with it -- there is no separate object to
-- drop and no way for the marker to survive the head it belongs to. That is
-- deliberate: a segment start left behind after the head was gone would let a
-- later `up` inherit a boundary it never wrote, and the verifier would then
-- classify rows as post-chain damage on the authority of a value from a
-- migration that had been rolled back. After a down, no chain has a recorded
-- segment start, every unlinked row reads as legacy again, and the next `up`
-- opens fresh segments from the first record written after it.

REVOKE ALL ON audit_chain_head FROM rasta_audit;
REVOKE USAGE ON TYPE audit_chain_scope FROM rasta_audit;

DROP TRIGGER IF EXISTS audit_chain_head_no_truncate ON audit_chain_head;
DROP TRIGGER IF EXISTS audit_chain_head_forward_only ON audit_chain_head;

DROP INDEX IF EXISTS audit_chain_head_month_idx;
DROP TABLE IF EXISTS audit_chain_head;

-- After the triggers that reference it.
DROP FUNCTION IF EXISTS refuse_chain_head_regression();

-- After the table whose column used it.
DROP TYPE IF EXISTS audit_chain_scope;

-- The chain-order index on the evidence table. Dropped because this migration
-- created it; the table, its other five indexes, its triggers and its grants
-- are untouched.
DROP INDEX IF EXISTS audit_event_chain_idx;

-- Last, and not optional. Without it `migrate deploy` still believes this
-- migration is applied and re-applies nothing, so an up -> down -> up cycle
-- silently ends without the head table it is supposed to restore.
DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20260910120000_audit_chain_head';
