-- One live availability window per machine, enforced by the database, and a
-- recorded reason for a window the system itself revokes (EXP-002 slice 7,
-- review #225 round 1, findings 3 and 4).
--
-- A declaration supersedes the machine's previous one: it revokes the live
-- window and creates the new one. That was an application-level promise only —
-- two declarations with different Idempotency-Keys for one machine each saw no
-- live window to revoke and each created one. The service now serialises
-- declarations per machine under the asset lock; this index is the backstop
-- that holds whatever path writes a row. "Live" is "not revoked", the state the
-- declaration path maintains; a window whose `to_at` has passed stays live
-- until the next declaration or a revoke, exactly as before.
--
-- WARNING: Prisma cannot express a partial index. `ux_availability_window_live`
-- lives in this migration only, and schema.prisma points here. A future
-- `prisma migrate dev` diff may propose dropping it. Delete that statement from
-- the generated migration; the database needs this object.
--
-- All-or-nothing, never a rewrite. A database that already holds two live
-- windows for one machine in one organization (the race above, which this
-- change closes) stops here with nothing changed and the query that lists them:
-- which declaration survives is the fleet manager's decision, not this
-- migration's.
BEGIN;

SET LOCAL lock_timeout = '3s';

DO $preflight$
DECLARE
  doubled integer;
BEGIN
  SELECT count(*) INTO doubled FROM (
    SELECT 1 FROM "availability_window" WHERE "revoked_at" IS NULL
     GROUP BY "organization_id", "asset_id" HAVING count(*) > 1) AS duplicates;
  IF doubled > 0 THEN
    RAISE EXCEPTION 'availability_window: % machine(s) have more than one live window; nothing was changed', doubled
      USING HINT = 'List them with: SELECT organization_id, asset_id, array_agg(id ORDER BY created_at) FROM availability_window WHERE revoked_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1; revoke all but the one to keep (SET revoked_at = now(), revoked_by = ''OPERATOR''), then deploy again.';
  END IF;
END
$preflight$;

-- Tenant-leading, like every index on this table.
CREATE UNIQUE INDEX "ux_availability_window_live"
  ON "availability_window" ("organization_id", "asset_id")
  WHERE "revoked_at" IS NULL;

-- Why the system revoked a window nobody revoked by hand: `ASSET_TRANSFERRED`
-- today. NULL for a revoke or a supersession by a person. A new nullable
-- column: nothing existing is read or rewritten.
ALTER TABLE "availability_window" ADD COLUMN "revoke_reason" TEXT;

COMMIT;
