-- MEMBER is intentionally conservative: includes INHERIT FALSE and SET FALSE.
-- PUBLIC is represented by its ACL grantee OID (0), not a login role.
SELECT r.oid FROM pg_roles r WHERE pg_has_role(RUNTIME_ROLE::regrole, r.oid, 'MEMBER')
UNION ALL SELECT 0::oid
