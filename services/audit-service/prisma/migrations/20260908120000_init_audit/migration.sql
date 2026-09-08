-- AUD-001 — the append-only audit store (ADR-053).
--
-- Written by hand rather than generated, because Prisma cannot express
-- declarative partitioning, per-partition triggers, or the privilege split this
-- table's central claim rests on.
--
-- Object names are deliberately unqualified. Prisma sets the connection's
-- search_path from the `?schema=` parameter, so the same file creates the
-- objects in `audit` for the service and in a throwaway schema for
-- `scripts/verify-migration-reversible.mjs`. Hard-coding `audit.` would make
-- the migration unverifiable.
--
-- In deployment that schema is `audit`, owned by `rasta_audit_migrator`.
-- The service connects as `rasta_audit`, which owns nothing here and is granted
-- only what it needs. That split is the barrier: measured on PostgreSQL 16.4, a
-- table owner denied UPDATE can simply grant it back to itself, and a role that
-- owns the database owns `public` through `pg_database_owner` and can DROP
-- another role's tables there. A schema the runtime role does not own is what
-- actually holds.

CREATE TYPE audit_actor_type AS ENUM ('USER', 'SERVICE', 'SYSTEM', 'ANONYMOUS');
CREATE TYPE audit_outcome AS ENUM ('SUCCESS', 'FAILURE', 'REFUSED');

-- ---------------------------------------------------------------------------
-- audit_event
--
-- Partitioned monthly on `occurred_at` (ADR § 11, docs/05 § 5.6). The partition
-- key is part of the primary key and of the idempotency key because PostgreSQL
-- requires it in every unique index on a partitioned table.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_event (
  id                     VARCHAR(64)  NOT NULL,
  occurred_at            TIMESTAMPTZ(6) NOT NULL,
  -- Database-generated, always. The gap between this and occurred_at is
  -- consumer lag; a value the application picked would measure nothing.
  recorded_at            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  actor_type             audit_actor_type NOT NULL,
  actor_id               VARCHAR(256),
  -- Empty array when unknown, never NULL. Path A always writes '{}'.
  actor_roles            TEXT[] NOT NULL DEFAULT '{}',

  organization_id        VARCHAR(128),

  action                 VARCHAR(256) NOT NULL,
  resource_type          VARCHAR(128) NOT NULL,
  resource_id            VARCHAR(256),

  outcome                audit_outcome NOT NULL,
  error_code             VARCHAR(128),
  reason                 VARCHAR(1000),
  changes                JSONB,
  occurrence_count       INTEGER NOT NULL DEFAULT 1,

  source_service         VARCHAR(128) NOT NULL,
  source_service_version VARCHAR(64),
  source_event_id        VARCHAR(128) NOT NULL,
  source_event_name      VARCHAR(128) NOT NULL,
  source_topic           VARCHAR(256) NOT NULL,

  source_ip              VARCHAR(64),
  source_user_agent      VARCHAR(512),

  correlation_id         VARCHAR(128) NOT NULL,
  causation_id           VARCHAR(128),
  traceparent            VARCHAR(256),

  source_stream_seq      BIGINT,

  -- Reserved for AUD-003. Never written by AUD-001; a NULL here means "no
  -- chain yet", not "verified".
  record_hash            BYTEA,
  previous_hash          BYTEA,

  sequence_no            BIGSERIAL NOT NULL,

  -- Reserved for corrections (ADR § 7). Never written by AUD-001.
  correction_of          VARCHAR(64),

  CONSTRAINT audit_event_pkey PRIMARY KEY (occurred_at, id),

  -- Structural bounds. Each one refuses a row that would be evidence of
  -- nothing: a blank actor id is not an actor, a blank correlation id joins to
  -- nothing, and a non-positive occurrence count describes no occurrence.
  CONSTRAINT audit_event_id_not_blank CHECK (length(btrim(id)) > 0),
  CONSTRAINT audit_event_action_not_blank CHECK (length(btrim(action)) > 0),
  CONSTRAINT audit_event_resource_type_not_blank CHECK (length(btrim(resource_type)) > 0),
  CONSTRAINT audit_event_source_service_not_blank CHECK (length(btrim(source_service)) > 0),
  CONSTRAINT audit_event_source_event_id_not_blank CHECK (length(btrim(source_event_id)) > 0),
  CONSTRAINT audit_event_source_event_name_not_blank CHECK (length(btrim(source_event_name)) > 0),
  CONSTRAINT audit_event_source_topic_not_blank CHECK (length(btrim(source_topic)) > 0),
  CONSTRAINT audit_event_correlation_id_not_blank CHECK (length(btrim(correlation_id)) > 0),
  CONSTRAINT audit_event_actor_id_not_blank CHECK (actor_id IS NULL OR length(btrim(actor_id)) > 0),
  CONSTRAINT audit_event_organization_id_not_blank CHECK (organization_id IS NULL OR length(btrim(organization_id)) > 0),
  CONSTRAINT audit_event_resource_id_not_blank CHECK (resource_id IS NULL OR length(btrim(resource_id)) > 0),
  CONSTRAINT audit_event_occurrence_count_positive CHECK (occurrence_count >= 1),
  CONSTRAINT audit_event_stream_seq_positive CHECK (source_stream_seq IS NULL OR source_stream_seq > 0),
  -- AUD-001 writes no delta; when AUD-004 does, it is an array (ADR § 5).
  CONSTRAINT audit_event_changes_is_array CHECK (changes IS NULL OR jsonb_typeof(changes) = 'array')
) PARTITION BY RANGE (occurred_at);

-- ADR § 8: one row per delivered source event per topic. Includes the
-- partition key because PostgreSQL requires it.
CREATE UNIQUE INDEX audit_event_source_identity_key
  ON audit_event (occurred_at, source_event_id, source_topic);

CREATE INDEX audit_event_org_time_idx      ON audit_event (organization_id, occurred_at DESC);
CREATE INDEX audit_event_time_idx          ON audit_event (occurred_at DESC);
CREATE INDEX audit_event_resource_idx      ON audit_event (resource_type, resource_id, occurred_at DESC);
CREATE INDEX audit_event_correlation_idx   ON audit_event (correlation_id);
CREATE INDEX audit_event_topic_time_idx    ON audit_event (source_topic, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Eighteen months of partitions, plus DEFAULT.
--
-- The DEFAULT partition is not a fallback nobody expects to use: it is how a
-- row with an occurred_at outside the declared range becomes *visible*
-- instead of being refused and lost. An audit store that drops evidence
-- because of a date is not an audit store (ADR § 11).
-- ---------------------------------------------------------------------------
CREATE TABLE audit_event_2026_09 PARTITION OF audit_event FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE audit_event_2026_10 PARTITION OF audit_event FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE audit_event_2026_11 PARTITION OF audit_event FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE audit_event_2026_12 PARTITION OF audit_event FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE audit_event_2027_01 PARTITION OF audit_event FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE audit_event_2027_02 PARTITION OF audit_event FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE audit_event_2027_03 PARTITION OF audit_event FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE audit_event_2027_04 PARTITION OF audit_event FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE audit_event_2027_05 PARTITION OF audit_event FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE audit_event_2027_06 PARTITION OF audit_event FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE audit_event_2027_07 PARTITION OF audit_event FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE audit_event_2027_08 PARTITION OF audit_event FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE audit_event_2027_09 PARTITION OF audit_event FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE audit_event_2027_10 PARTITION OF audit_event FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE audit_event_2027_11 PARTITION OF audit_event FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE audit_event_2027_12 PARTITION OF audit_event FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');
CREATE TABLE audit_event_2028_01 PARTITION OF audit_event FOR VALUES FROM ('2028-01-01') TO ('2028-02-01');
CREATE TABLE audit_event_2028_02 PARTITION OF audit_event FOR VALUES FROM ('2028-02-01') TO ('2028-03-01');
CREATE TABLE audit_event_default PARTITION OF audit_event DEFAULT;

-- ---------------------------------------------------------------------------
-- Append-only enforcement, layer 2 (ADR § 6).
--
-- Layer 1 is the grant list at the bottom of this file. This trigger is defence
-- in depth: it survives a future migration that re-grants UPDATE by mistake.
-- ---------------------------------------------------------------------------
CREATE FUNCTION refuse_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only: % is refused', TG_OP
    USING ERRCODE = '55006';
END;
$$;

-- Row-level UPDATE/DELETE triggers on a partitioned parent ARE cloned to every
-- partition by PostgreSQL, so this one statement also protects each partition
-- against direct access. Verified on 16.4.
CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- Statement-level TRUNCATE triggers are NOT cloned, and that asymmetry is a
-- real hole rather than a detail: with only a parent trigger,
-- `TRUNCATE audit_event_2026_09` succeeds and silently empties a month.
-- Measured, then closed by creating the trigger on the parent *and* on every
-- partition below.
CREATE TRIGGER audit_event_append_only_truncate
  BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2026_09 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2026_10 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2026_11 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2026_12 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2027_01 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2027_02 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2027_03 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2027_04 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2027_05 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2027_06 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2027_07 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2027_08 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2027_09 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2027_10 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2027_11 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2027_12 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2028_01 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_2028_02 FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER audit_event_append_only_truncate BEFORE TRUNCATE ON audit_event_default FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

-- ---------------------------------------------------------------------------
-- Consumer idempotency (AGENTS.md A-09). Written in the same transaction as the
-- audit row, so an event is never marked processed without its evidence.
-- ---------------------------------------------------------------------------
CREATE TABLE processed_event (
  event_id      VARCHAR(128) NOT NULL,
  consumer_name VARCHAR(128) NOT NULL,
  processed_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT processed_event_pkey PRIMARY KEY (event_id, consumer_name),
  CONSTRAINT processed_event_event_id_not_blank CHECK (length(btrim(event_id)) > 0),
  CONSTRAINT processed_event_consumer_not_blank CHECK (length(btrim(consumer_name)) > 0)
);

-- ---------------------------------------------------------------------------
-- A local note of which organizations have been seen. A projection so AUD-002
-- can scope a query without a cross-service call on the read path -- never a
-- replica of organization-service's rows (AGENTS.md A-01, A-02).
-- ---------------------------------------------------------------------------
CREATE TABLE organization_ref (
  organization_id VARCHAR(128) NOT NULL,
  first_seen_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT organization_ref_pkey PRIMARY KEY (organization_id),
  CONSTRAINT organization_ref_id_not_blank CHECK (length(btrim(organization_id)) > 0)
);
CREATE INDEX organization_ref_last_seen_idx ON organization_ref (last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- Append-only enforcement, layer 1 — privileges (ADR § 6).
--
-- Granted on the parent only. A partition is never named by this service's
-- queries: routing an INSERT through the parent checks the parent's privileges,
-- so withholding partition grants costs nothing and removes a direct path.
--
-- No UPDATE. No DELETE. No TRUNCATE. `rasta_audit` owns none of these objects,
-- so unlike an owner it cannot grant them back to itself.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON audit_event TO rasta_audit;
-- BIGSERIAL needs the sequence to insert.
GRANT USAGE, SELECT ON SEQUENCE audit_event_sequence_no_seq TO rasta_audit;

-- processed_event is bookkeeping, not evidence: it may be read and written but
-- still never deleted, so a replay cannot be made to look like a first delivery.
GRANT SELECT, INSERT ON processed_event TO rasta_audit;

-- organization_ref is a projection and is upserted, so it needs UPDATE. It
-- holds no evidence; losing it costs a display name, not a record.
GRANT SELECT, INSERT, UPDATE ON organization_ref TO rasta_audit;

