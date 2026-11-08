-- -----------------------------------------------------------------------------
-- The ONE place a database may let a runtime role in that is not its own
-- (#540 r1 F2, D-097): runtime-foreign.sql reports every other right a foreign
-- runtime role holds, in every database of the cluster. One row per database,
-- database-level privilege and grantee, with the reason.
--
-- No row names a service database (`rasta_<svc>`): each refuses every runtime
-- role but its own, with no exception — check-db-runtime-privileges-lib.test.mjs
-- fails on one. The rows below are the databases no service owns, created by
-- PostgreSQL, the postgis image or 00-init-databases.sh, and only PostgreSQL's
-- own default there: PUBLIC may connect (and make temporary tables, which end
-- with the session). Every object right in them, and any grant beyond these
-- two, is still a finding; a database not listed here — a leftover, a new one
-- — refuses every runtime role.
--
-- keycloak, temporal and temporal_visibility (D-100): PUBLIC would lose
-- CONNECT and TEMPORARY at bootstrap if each were owned by a dedicated role.
-- 00-init-databases.sh creates them OWNER the bootstrap superuser, which
-- Keycloak and Temporal connect as, so they stay tolerated here;
-- check-db-runtime-privileges-lib.test.mjs fails once one gets an owner of its
-- own — then revoke PUBLIC there and drop its rows.
-- -----------------------------------------------------------------------------
SELECT database, privilege, grantee, reason FROM (VALUES
  ('postgres', 'CONNECT', 'PUBLIC', 'PostgreSQL''s maintenance database; holds no Rasta data'),
  ('postgres', 'TEMPORARY', 'PUBLIC', 'PostgreSQL''s default; temporary tables end with the session'),
  ('template1', 'CONNECT', 'PUBLIC', 'PostgreSQL''s template; holds the extensions every database copies, no data'),
  ('template_postgis', 'CONNECT', 'PUBLIC', 'the postgis image''s template; no data'),
  ('template_postgis', 'TEMPORARY', 'PUBLIC', 'PostgreSQL''s default; temporary tables end with the session'),
  ('keycloak', 'CONNECT', 'PUBLIC', 'PostgreSQL''s default; owned by the bootstrap superuser, not a dedicated role, and Keycloak connects as that superuser (D-100); no grant to anyone else'),
  ('keycloak', 'TEMPORARY', 'PUBLIC', 'PostgreSQL''s default; temporary tables end with the session'),
  ('temporal', 'CONNECT', 'PUBLIC', 'PostgreSQL''s default; owned by the bootstrap superuser, not a dedicated role, and Temporal connects as that superuser (D-100); no grant to anyone else'),
  ('temporal', 'TEMPORARY', 'PUBLIC', 'PostgreSQL''s default; temporary tables end with the session'),
  ('temporal_visibility', 'CONNECT', 'PUBLIC', 'Temporal''s visibility store; owned and connected to as temporal is (D-100)'),
  ('temporal_visibility', 'TEMPORARY', 'PUBLIC', 'PostgreSQL''s default; temporary tables end with the session')
) x(database, privilege, grantee, reason)
