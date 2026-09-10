-- AUD-003 -- the hash chain's head table and the index its verification walks
-- (ADR-053 § 6, layer 3).
--
-- Additive only. Neither `20260908120000_init_audit` nor
-- `20260909093000_audit_org_hierarchy_projection` is rewritten: the first one
-- created the partitioned evidence table, both append-only layers and the
-- nineteen partitions, and the second one grew the authorization projection.
-- Re-running either is a migration nobody wants to run twice.
--
-- ## Nothing here backfills, and that is the whole compatibility story
--
-- `record_hash` and `previous_hash` have existed since AUD-001 and have always
-- been NULL. This migration does **not** fill them in. Backfilling would mean
-- computing a chain over rows nobody chained at the time and then asserting the
-- result is evidence, which is the one operation an append-only store must
-- never perform: it would make a fabricated chain indistinguishable from a real
-- one. Rows written before this migration therefore stay exactly as they were
-- written, and the verification endpoint reports them as an explicit
-- `UNVERIFIABLE_LEGACY` boundary rather than as "valid".
--
-- The first record written after this migration in each (organization, month)
-- starts a fresh verifiable segment with `previous_hash = NULL`, because no
-- chain head exists for it yet. That boundary is visible in the data and is
-- documented in `docs/runbooks/audit-chain-divergence.md`.
--
-- ## Why the head is a table and not a `max()` over the evidence
--
-- The chain's tip has to be readable and lockable *before* the next row exists,
-- so the next row can be linked to it inside the same transaction. A `SELECT
-- max(...)` over `audit_event` locks nothing, which would let two concurrent
-- inserts read the same tip and write two rows claiming the same predecessor --
-- a fork, silently, under exactly the load the store is most needed under.
-- A single head row per chain, taken with `FOR UPDATE`, is what makes the
-- assignment atomic (`AuditRepository.ingest`).
--
-- ## The key, and the platform chain that must not collide with a tenant
--
-- ADR-053 § 6 scopes a chain to `(organizationId, partition month)`, and
-- `organization_id` on `audit_event` is nullable for genuinely platform-scoped
-- actions. A nullable column cannot be a primary key, and `UNIQUE` treats NULLs
-- as distinct in PostgreSQL, so keying on the nullable value directly would
-- allow two platform heads for the same month -- which is a fork by
-- construction.
--
-- So the key carries an explicit `chain_scope` discriminator and a NOT NULL
-- `organization_id` whose value for the platform chain is the empty string.
-- The empty string is provably not a real organization identifier:
-- `audit_event_organization_id_not_blank` has refused a blank one since
-- AUD-001, and `audit_chain_head_scope_shape` below refuses one here. The
-- discriminator means the two families stay distinguishable even if that ever
-- changed.
--
-- ## Privileges
--
-- `rasta_audit` gets SELECT, INSERT and UPDATE on the head, and nothing else.
-- UPDATE is unavoidable -- a head advances -- and it is why the head is a
-- separate table from the evidence rather than a column on it: the evidence
-- keeps its "no UPDATE at all" grant untouched. No DELETE and no TRUNCATE, and
-- a trigger refuses both anyway.

-- ---------------------------------------------------------------------------
-- Which chain family a head belongs to.
-- ---------------------------------------------------------------------------
CREATE TYPE audit_chain_scope AS ENUM (
  -- One tenant's month. `organization_id` is that tenant's identifier.
  'ORGANIZATION',
  -- The platform's own month: rows whose `organization_id IS NULL`.
  -- `organization_id` here is the empty string, which no tenant can hold.
  'PLATFORM'
);

CREATE TABLE audit_chain_head (
  chain_scope       audit_chain_scope NOT NULL,
  organization_id   VARCHAR(128) NOT NULL,
  -- Always the first day of a UTC month. Stored as DATE so the value has one
  -- spelling and no timezone to be reinterpreted in.
  chain_month       DATE NOT NULL,

  -- Zero means "this chain exists and is empty", which is a real state: the
  -- row is created by the first writer before it knows its own hash, so that
  -- the lock it needs has something to lock.
  chain_length      BIGINT NOT NULL DEFAULT 0,

  head_hash         BYTEA,
  head_event_id     VARCHAR(64),
  head_occurred_at  TIMESTAMPTZ(6),
  head_sequence_no  BIGINT,

  -- Where this chain's *verifiable segment* begins: the `sequence_no` of the
  -- first record ever linked into this chain. Written once, on the
  -- chain_length 0 -> 1 transition, and immutable from then on (the trigger
  -- below refuses any other value).
  --
  -- ## Why a null hash needs a provable boundary
  --
  -- `record_hash` is NULL on two kinds of row and they mean opposite things.
  -- A row written before this migration was never chained, is never
  -- backfilled, and is honestly unverifiable. A row written after it and then
  -- stripped of its link is integrity damage. Without a recorded boundary the
  -- verifier can only see "NULL" and would have to call both of them legacy --
  -- which hands a privileged attacker a way to erase a record's link and have
  -- the verification endpoint report the result as harmless history.
  --
  -- The boundary is provable rather than inferred because `sequence_no` comes
  -- from one cluster-wide sequence: every pre-migration row drew a lower value
  -- than any post-migration row, so "before the segment start" is exactly
  -- "written before this chain was chained". The verifier therefore reads a
  -- NULL hash below `first_sequence_no` as legacy and a NULL hash at or above
  -- it as DIVERGENT.
  first_sequence_no BIGINT,

  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT audit_chain_head_pkey PRIMARY KEY (chain_scope, organization_id, chain_month),

  -- The platform chain is the empty organization key and nothing else; a tenant
  -- chain is a non-blank identifier and nothing else. Together with the primary
  -- key this makes "one head per (tenant-or-platform, month)" a structural fact
  -- rather than an application convention.
  CONSTRAINT audit_chain_head_scope_shape CHECK (
    (chain_scope = 'PLATFORM' AND organization_id = '')
    OR (chain_scope = 'ORGANIZATION' AND length(btrim(organization_id)) > 0)
  ),

  -- A month, not a day. Without this a caller could open 28 extra chains for
  -- one month by writing 28 different dates, and each would verify in
  -- isolation while proving nothing about the others.
  CONSTRAINT audit_chain_head_month_is_first_day CHECK (EXTRACT(DAY FROM chain_month) = 1),

  CONSTRAINT audit_chain_head_length_not_negative CHECK (chain_length >= 0),

  -- The two legal shapes, and no third. A head that claims a length but names
  -- no record, or names a record but carries no hash, is a chain nothing can be
  -- linked to -- and would be read as "empty" by the next writer, which is how
  -- a chain silently restarts.
  CONSTRAINT audit_chain_head_state CHECK (
    (chain_length = 0
      AND head_hash IS NULL AND head_event_id IS NULL
      AND head_occurred_at IS NULL AND head_sequence_no IS NULL
      AND first_sequence_no IS NULL)
    OR (chain_length > 0
      AND head_hash IS NOT NULL AND head_event_id IS NOT NULL
      AND head_occurred_at IS NOT NULL AND head_sequence_no IS NOT NULL
      AND first_sequence_no IS NOT NULL)
  ),

  -- A segment starts at or before its own tip, and a chain of one starts at
  -- it. Without this a head could name a segment start *after* the record it
  -- points at, which would place every record of the chain "before the segment
  -- start" and turn the whole segment back into unverifiable legacy -- the
  -- exact reading the column exists to make impossible.
  CONSTRAINT audit_chain_head_segment_start_ordered CHECK (
    first_sequence_no IS NULL OR first_sequence_no <= head_sequence_no
  ),

  -- A chain of exactly one record starts and ends at the same position.
  CONSTRAINT audit_chain_head_single_record_segment CHECK (
    chain_length <> 1 OR first_sequence_no = head_sequence_no
  ),

  -- SHA-256 and nothing else. A short digest here would be a weaker chain that
  -- still looked like a chain.
  CONSTRAINT audit_chain_head_hash_is_sha256 CHECK (
    head_hash IS NULL OR octet_length(head_hash) = 32
  ),

  CONSTRAINT audit_chain_head_event_id_not_blank CHECK (
    head_event_id IS NULL OR length(btrim(head_event_id)) > 0
  )
);

-- "Which chains does this month hold" -- the shape the verification endpoint
-- and any future digest publication both ask.
CREATE INDEX audit_chain_head_month_idx ON audit_chain_head (chain_month, chain_scope);

-- ---------------------------------------------------------------------------
-- The head advances forward, one record at a time, or not at all.
--
-- This is the head's equivalent of the evidence table's append-only trigger,
-- and it closes the attack the chain would otherwise still be open to from
-- inside the application: rewinding a head lets the next legitimate insert
-- re-link onto an older tip, which forks the chain without ever touching a
-- committed audit row.
--
-- Identity is immutable for the same reason a partition key is: moving a head
-- from one chain to another would hand one tenant's tip to another's writer.
-- ---------------------------------------------------------------------------
CREATE FUNCTION refuse_chain_head_regression() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'audit_chain_head is forward-only: % is refused', TG_OP
      USING ERRCODE = '55006';
  END IF;

  IF NEW.chain_scope IS DISTINCT FROM OLD.chain_scope
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.chain_month IS DISTINCT FROM OLD.chain_month THEN
    RAISE EXCEPTION 'audit_chain_head identity is immutable'
      USING ERRCODE = '55006';
  END IF;

  IF NEW.chain_length <> OLD.chain_length + 1 THEN
    RAISE EXCEPTION 'audit_chain_head advances exactly one record at a time (% -> %)',
      OLD.chain_length, NEW.chain_length
      USING ERRCODE = '55006';
  END IF;

  -- The segment start is written exactly once and never again.
  --
  -- On the 0 -> 1 transition it must be the position of the record being
  -- linked, because that record *is* the start of the segment. On every later
  -- advance it must be byte-for-byte what it already was. Moving it forward
  -- would reclassify every record between the old and the new value as
  -- pre-chain legacy, which is how an attacker with UPDATE on this table would
  -- launder the deletion of a record's link past the verifier; moving it
  -- backward would claim a chained segment over rows that were never chained.
  IF OLD.chain_length = 0 THEN
    IF NEW.first_sequence_no IS NULL OR NEW.first_sequence_no <> NEW.head_sequence_no THEN
      RAISE EXCEPTION
        'audit_chain_head first_sequence_no must open the segment at the first record (% vs %)',
        NEW.first_sequence_no, NEW.head_sequence_no
        USING ERRCODE = '55006';
    END IF;
  ELSIF NEW.first_sequence_no IS DISTINCT FROM OLD.first_sequence_no THEN
    RAISE EXCEPTION 'audit_chain_head first_sequence_no is immutable (% -> %)',
      OLD.first_sequence_no, NEW.first_sequence_no
      USING ERRCODE = '55006';
  END IF;

  -- The tip moves forward through the sequence, never back. The chain_length
  -- rule above does not imply this on its own: a head could advance its length
  -- while naming an *earlier* record, which is the rewind this trigger exists
  -- to refuse.
  IF NEW.head_sequence_no IS NULL OR NEW.head_sequence_no <= COALESCE(OLD.head_sequence_no, -1) THEN
    RAISE EXCEPTION 'audit_chain_head head_sequence_no must move forward (% -> %)',
      OLD.head_sequence_no, NEW.head_sequence_no
      USING ERRCODE = '55006';
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'audit_chain_head created_at is immutable'
      USING ERRCODE = '55006';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_chain_head_forward_only
  BEFORE UPDATE OR DELETE ON audit_chain_head
  FOR EACH ROW EXECUTE FUNCTION refuse_chain_head_regression();

-- Statement-level, because TRUNCATE is not a row event and the row trigger
-- above would never see it. `audit_chain_head` is not partitioned, so one
-- trigger covers it -- unlike `audit_event`, where the same asymmetry needed a
-- trigger per partition.
CREATE TRIGGER audit_chain_head_no_truncate
  BEFORE TRUNCATE ON audit_chain_head
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_chain_head_regression();

-- ---------------------------------------------------------------------------
-- The chain-order index on the evidence.
--
-- Verification walks one chain in the order the chain was built, which is
-- `sequence_no` ascending within a partition: `sequence_no` is now allocated
-- while the writer holds the head's row lock, so allocation order and chain
-- order are the same order by construction (`AuditRepository.ingest`).
--
-- `occurred_at` is absent from the index on purpose. It is the partition key,
-- so the planner has already pruned to one month's partition before this index
-- is consulted, and repeating it would only widen every entry.
--
-- Created on the partitioned parent, which PostgreSQL clones to all nineteen
-- partitions. It is an ordinary (non-unique) index, so `organization_id IS
-- NULL` -- the platform chain -- is served by it too.
-- ---------------------------------------------------------------------------
CREATE INDEX audit_event_chain_idx ON audit_event (organization_id, sequence_no);

-- ---------------------------------------------------------------------------
-- Runtime privileges -- the least the write path and the read path need.
-- ---------------------------------------------------------------------------
-- USAGE on the enum so the runtime role can write the discriminator.
-- PostgreSQL grants type USAGE to PUBLIC by default; saying it here means a
-- deployment that revokes the public default does not break ingestion in a way
-- that only shows up on the first insert after a restart.
GRANT USAGE ON TYPE audit_chain_scope TO rasta_audit;

-- SELECT to read and lock the tip, INSERT to open a chain, UPDATE to advance
-- it. No DELETE and no TRUNCATE -- and the trigger above refuses both even if
-- a later migration granted them by mistake.
GRANT SELECT, INSERT, UPDATE ON audit_chain_head TO rasta_audit;

-- Restated, not widened. The evidence table's grant is unchanged from
-- `20260908120000_init_audit`: SELECT and INSERT, never UPDATE, DELETE or
-- TRUNCATE. An append-only store's privilege list should be readable at the end
-- of every migration that touches the store, so a future addition shows up in
-- review rather than being inherited silently.
GRANT SELECT, INSERT ON audit_event TO rasta_audit;
GRANT USAGE, SELECT ON SEQUENCE audit_event_sequence_no_seq TO rasta_audit;
