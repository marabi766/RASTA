-- Reverses the AUD-002 authorization projection, and nothing else.
--
-- `organization_ref` itself, its primary key and its last-seen index belong to
-- `20260908120000_init_audit` and are left standing: this migration added
-- columns to a table it did not create, so its rollback removes columns and
-- leaves the table. The chain runs down scripts newest-first, so the init
-- script drops the table afterwards.
--
-- Rolling this back destroys the hierarchy this service holds. That is not a
-- data-loss accident to be discovered later: the projection is rebuilt by
-- replaying `rasta.organization.v1`, and domain topics retain seven days
-- (ADR-053 § 8), so a rollback older than the retention window leaves
-- `UNION_ADMIN` scoping able to reach a caller's own organization and nothing
-- beneath it -- which is the fail-closed direction, and is why this is a
-- recoverable rollback rather than a destructive one.

REVOKE USAGE ON TYPE organization_relation_state FROM rasta_audit;

DROP INDEX IF EXISTS organization_ref_relation_state_idx;
DROP INDEX IF EXISTS organization_ref_parent_idx;

ALTER TABLE organization_ref
  DROP CONSTRAINT IF EXISTS organization_ref_parent_not_blank,
  DROP CONSTRAINT IF EXISTS organization_ref_projected_has_observation,
  DROP CONSTRAINT IF EXISTS organization_ref_parent_not_self;

ALTER TABLE organization_ref
  DROP COLUMN IF EXISTS relation_observed_at,
  DROP COLUMN IF EXISTS relation_state,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS hierarchy_depth,
  DROP COLUMN IF EXISTS hierarchy_path,
  DROP COLUMN IF EXISTS parent_organization_id;

-- After the columns, because the column above depends on the type.
DROP TYPE IF EXISTS organization_relation_state;

-- Last, and not optional. Without it `migrate deploy` still believes this
-- migration is applied and re-applies nothing, so an up -> down -> up cycle
-- silently ends without the projection it is supposed to restore.
DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20260909093000_audit_org_hierarchy_projection';
