-- L7-44 / ADR-011, part of the tenant-leading rebuild of notification keys:
-- see 20260925120300_tenant_leading_swap for the whole change and why.
--
-- One statement, on purpose. CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block, and PostgreSQL runs a multi-statement script as one
-- implicit transaction; a file holding only this statement runs outside one,
-- under `prisma migrate deploy` and `prisma db execute` alike. The build takes
-- no lock that blocks writes. If it fails it leaves an INVALID index behind:
-- the swap refuses to use one, and the fix is DROP INDEX on it and a re-run.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "notification_quiet_hours_pkey_next"
    ON "notification_quiet_hours" ("organization_id", "user_id");
