-- AUD-002 -- the authorization projection the query API needs (ADR-053 § 10).
--
-- Additive only. `20260908120000_init_audit` is merged and is not rewritten:
-- it created the partitioned evidence table, both append-only layers and the
-- eighteen partitions, and re-running any of that is a migration nobody wants
-- to run twice.
--
-- ## Why organization_ref grows instead of a new table appearing
--
-- AUD-001 left `organization_ref` holding an identifier and the window it was
-- observed in. That is enough to list tenants; it is **not** enough to decide
-- whether one organization sits beneath another, and ADR-053 § 10 makes that
-- decision the whole of `UNION_ADMIN` scoping. Equality is not a subtree, and a
-- query API that shipped with equality standing in for one would be a
-- cross-tenant read waiting for the first union with children.
--
-- ## Adjacency, not the materialised path -- and this is the security decision
--
-- organization-service publishes a `path` on ORGANIZATION_CREATED and a
-- `newPath` on ORGANIZATION_MOVED. A move rewrites the path of **every
-- descendant** in that service's own database but publishes **one** event, for
-- the organization that moved. A consumer that authorised from stored paths
-- would therefore keep every descendant's path forever wrong after the first
-- move -- and wrong in the broadening direction, which is the one direction
-- ADR-053 § 10 forbids.
--
-- A descendant's *parent* does not change when its ancestor moves. So the
-- authority here is `parent_organization_id`, maintained from CREATED and
-- MOVED, and walked upwards at query time. `hierarchy_path` and
-- `hierarchy_depth` are recorded for diagnostics and are never read by an
-- authorization decision.
--
-- ## relation_state is what makes a missing projection fail closed
--
-- AUD-001 upserts a row here for the tenant of every audit event, which is a
-- bare identifier with no hierarchy behind it. Those rows must never be
-- mistaken for "a root, because parent_organization_id is NULL". The enum
-- separates the two: only PROJECTED rows -- rows an organization event actually
-- described -- take part in a subtree decision, and everything else is
-- invisible to it.
--
-- ## No privilege is widened
--
-- `rasta_audit` already holds SELECT, INSERT, UPDATE on this table and a
-- table-level grant covers columns added later, so nothing below grants a new
-- capability. The grant is restated anyway, and only for those three verbs: an
-- append-only store's privilege list should be readable in one place at the end
-- of every migration that touches it, and restating it is how a future DELETE
-- becomes visible in review rather than inherited silently.

-- ---------------------------------------------------------------------------
-- How much this service knows about one organization's place in the hierarchy.
-- ---------------------------------------------------------------------------
CREATE TYPE organization_relation_state AS ENUM (
  -- Seen only as the tenant of an audit event. The identifier is real; its
  -- parent is unknown. Never a subtree member and never a subtree root.
  'UNKNOWN',
  -- Described by an ORGANIZATION_CREATED or ORGANIZATION_MOVED event, so the
  -- parent link on this row came from the owning service.
  'PROJECTED'
);

ALTER TABLE organization_ref
  ADD COLUMN parent_organization_id VARCHAR(128),
  ADD COLUMN hierarchy_path         VARCHAR(2048),
  ADD COLUMN hierarchy_depth        INTEGER,
  ADD COLUMN status                 VARCHAR(64),
  ADD COLUMN relation_state         organization_relation_state NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN relation_observed_at   TIMESTAMPTZ(6);

-- A one-node cycle is the cheapest way to make the upward walk below never
-- terminate, and the only way it can arise is a projection bug. Refused in the
-- database so it cannot be written at all.
ALTER TABLE organization_ref
  ADD CONSTRAINT organization_ref_parent_not_self
  CHECK (parent_organization_id IS DISTINCT FROM organization_id);

-- A PROJECTED row must carry the moment its relation was observed: that value
-- is what makes the projection monotonic under replay and out-of-order
-- delivery. A row claiming to be projected with no observation behind it would
-- silently accept every later event, including an older one.
ALTER TABLE organization_ref
  ADD CONSTRAINT organization_ref_projected_has_observation
  CHECK (relation_state <> 'PROJECTED' OR relation_observed_at IS NOT NULL);

ALTER TABLE organization_ref
  ADD CONSTRAINT organization_ref_parent_not_blank
  CHECK (parent_organization_id IS NULL OR length(btrim(parent_organization_id)) > 0);

-- The recursive walk joins child.parent_organization_id to parent's primary
-- key, so the primary key serves the upward direction. This index serves the
-- downward one -- listing a subtree for diagnostics, and any future descendant
-- enumeration -- and keeps a parent lookup off a sequential scan as the
-- projection grows.
-- Not a partial index, deliberately. Prisma cannot express a WHERE predicate,
-- so a partial one here would show as permanent drift against `schema.prisma`
-- and the next `migrate dev` would offer to reset the database to "fix" it.
CREATE INDEX organization_ref_parent_idx
  ON organization_ref (parent_organization_id);

-- Serves "which organizations do we hold a usable hierarchy for", which is the
-- shape every fail-closed check asks before it walks anything.
CREATE INDEX organization_ref_relation_state_idx
  ON organization_ref (relation_state);

-- ---------------------------------------------------------------------------
-- Runtime privileges -- restated, not widened.
-- ---------------------------------------------------------------------------
-- USAGE on the enum so the runtime role can write the column. PostgreSQL grants
-- type USAGE to PUBLIC by default; saying it here means a deployment that
-- revokes the public default does not break ingestion in a way that only shows
-- up on the first ORGANIZATION_CREATED after a restart.
GRANT USAGE ON TYPE organization_relation_state TO rasta_audit;

-- Unchanged from the init migration: read, insert, update. No DELETE and no
-- TRUNCATE, on the projection as on the evidence.
GRANT SELECT, INSERT, UPDATE ON organization_ref TO rasta_audit;
