-- Run with psql -X -qAt, using PG* credentials. Save outside the repository.
-- Names rather than OIDs make before/after comparisons readable.
SELECT 'database', datname, datacl::text FROM pg_database WHERE datname = current_database();
SELECT 'schema', nspname, nspacl::text FROM pg_namespace ORDER BY nspname;
SELECT 'relation', n.nspname || '.' || c.relname, c.relacl::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 2;
SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname, a.attacl::text
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE a.attacl IS NOT NULL ORDER BY 2;
SELECT 'function', p.oid::regprocedure::text, p.proacl::text FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 2;
SELECT 'default', pg_get_userbyid(d.defaclrole), coalesce(n.nspname, '*'),
  d.defaclobjtype::text, d.defaclacl::text FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace ORDER BY 2,3,4;
