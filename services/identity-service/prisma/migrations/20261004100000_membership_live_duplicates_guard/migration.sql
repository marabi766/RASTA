-- =============================================================================
-- identity-service — refuse to proceed while a user holds two live memberships
-- in one organization.
--
-- The membership table's only uniqueness was
-- membership_user_id_organization_id_deleted_at_key on (user_id,
-- organization_id, deleted_at). NULLs are distinct in a unique index, so two
-- live rows (deleted_at NULL) for the same user and organization were both
-- accepted: two concurrent addMembership calls each passed the existence check
-- and each inserted, with two MEMBERSHIP_CREATED events. The next migration
-- adds the partial unique index that forbids it.
--
-- That index cannot be built over duplicates, and a membership is an access
-- grant: which of two live rows to keep — their roles, validity windows and
-- audit trail differ — is a decision for an operator, never for a migration.
-- So this one refuses, counting only (no ids or user data in the error); the
-- HINT gives the query that lists them.
--
-- First it drops an INVALID leftover of that index, if one is there. The build
-- (next migration) runs CONCURRENTLY, which cannot share a file with anything,
-- so a duplicate written between this check and the build makes the build fail
-- and leaves ux_membership_live_user_org behind INVALID: enforcing nothing,
-- and holding the name. Prisma re-runs only the failed migration, so the
-- recovery (docs/runbooks/database-bootstrap.md#identity-one-live-membership)
-- re-runs this one too: the leftover goes here, the duplicates are checked
-- again, and the build starts from nothing. A VALID index is never dropped.
-- Dropping an index is a catalogue change: its exclusive lock is held for
-- milliseconds, and lock_timeout bounds the wait for it.
-- =============================================================================
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = to_regclass('ux_membership_live_user_org')
       AND NOT i.indisvalid
  ) THEN
    DROP INDEX "ux_membership_live_user_org";
  END IF;
END $$;

DO $$
DECLARE
  duplicates integer;
BEGIN
  SELECT count(*) INTO duplicates FROM (
    SELECT 1 FROM "membership"
     WHERE "deleted_at" IS NULL
     GROUP BY "user_id", "organization_id"
    HAVING count(*) > 1
  ) AS live_duplicates;
  IF duplicates > 0 THEN
    RAISE EXCEPTION
      'membership: % (user, organization) pair(s) hold more than one live membership; refusing to add ux_membership_live_user_org',
      duplicates
      USING HINT = 'List them with: SELECT user_id, organization_id, array_agg(id ORDER BY created_at) FROM membership WHERE deleted_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1; resolve each through the membership revoke path (which records who and why), never by DELETE, then deploy again.';
  END IF;
END $$;
