-- L7-44 / ADR-011: every composite index on a tenant table leads with
-- organization_id.
--
-- Three keys here led with user_id instead:
--
--   ux_preference_owner_scope_channel   (user_id, organization_id, scope, scope_key, channel)
--   ux_preference_global_channel        (user_id, organization_id, channel) WHERE scope = 'GLOBAL'
--   notification_quiet_hours_pkey       (user_id, organization_id)
--
-- Every read of either table is tenant-scoped by the guard and names the user
-- as well: `organization_id = $1 AND user_id = $2`, or `user_id IN (...)` for
-- a dispatch. So each table also carried a separate index to serve that shape
-- (`ix_preference_owner`, `ix_quiet_hours_org`).
--
-- Reordering the keys changes nothing about what they refuse: the column sets
-- are the same, so the same rows collide. With organization_id first, the
-- unique key and the primary key serve the tenant reads themselves, and the
-- two helper indexes become exact prefixes of them. They are dropped.
--
-- How, without a window and without blocking writes for a build:
--
--   20260925120000..120200  build each replacement CONCURRENTLY under a
--                           `_next` name, one statement per migration (the
--                           only way CONCURRENTLY runs under Prisma).
--   this migration          swaps them in. One script, so one implicit
--                           transaction: every step below lands together or
--                           not at all, and at no instant is either table
--                           without its key. Nothing here builds an index —
--                           each step is a catalogue change, so the exclusive
--                           locks it takes are held for milliseconds.
--
-- The primary key moves with ADD CONSTRAINT ... PRIMARY KEY USING INDEX,
-- which adopts the prebuilt unique index (and renames it to the constraint's
-- name) instead of building one.

SET LOCAL lock_timeout = '5s';

-- A CONCURRENTLY build that failed leaves an INVALID index behind, which
-- enforces nothing. Swapping one in would drop a working key for it.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(name, ', ') INTO bad
  FROM unnest(ARRAY[
    'ux_preference_owner_scope_channel_next',
    'ux_preference_global_channel_next',
    'notification_quiet_hours_pkey_next'
  ]) AS name
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass(name) AND i.indisvalid AND i.indisready
  );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'Replacement index(es) missing or invalid: %. DROP INDEX each one, then deploy again so the CONCURRENTLY migrations rebuild them.',
      bad;
  END IF;
END $$;

-- notification_preference ---------------------------------------------------

DROP INDEX "ux_preference_owner_scope_channel";
ALTER INDEX "ux_preference_owner_scope_channel_next" RENAME TO "ux_preference_owner_scope_channel";

-- The GLOBAL half of the same rule, because NULL is distinct in a unique index.
DROP INDEX "ux_preference_global_channel";
ALTER INDEX "ux_preference_global_channel_next" RENAME TO "ux_preference_global_channel";

-- A prefix of ux_preference_owner_scope_channel now.
DROP INDEX "ix_preference_owner";

-- notification_quiet_hours --------------------------------------------------

ALTER TABLE "notification_quiet_hours" DROP CONSTRAINT "notification_quiet_hours_pkey";
ALTER TABLE "notification_quiet_hours"
  ADD CONSTRAINT "notification_quiet_hours_pkey" PRIMARY KEY USING INDEX "notification_quiet_hours_pkey_next";

-- A prefix of the primary key now.
DROP INDEX "ix_quiet_hours_org";
