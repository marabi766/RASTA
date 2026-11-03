-- -----------------------------------------------------------------------------
-- Everything a service's runtime role may hold (D-045, #421 r1 F3b): the ONE
-- allowlist. runtime-forbidden.sql turns it round — every right the runtime
-- closure (runtime-reachable.sql: the role, every role it is a MEMBER of, and
-- PUBLIC) holds on an object of the database that no row here allows — and
-- both sides read that: lib/service-privilege-split.bash revokes it, then fails
-- unless nothing is left; scripts/check-db-runtime-privileges.mjs reports it,
-- and also reports a right allowed here that the runtime role does NOT hold,
-- so this file and the services' migrations must say the same thing.
--
-- One row per policy, class, object and the privileges allowed:
--
--   policy      `default` — every split service in grants mode `default`
--               (lib/role-passwords.bash privilege_split_grants_mode);
--               a service's own name — a split service in mode `migration`,
--               whose migrations grant per table;
--               `audit` — audit-service (split_audit_database_privileges);
--               `*` — every policy.
--   class       database, schema, relation (tables, partitioned tables and
--               each partition, views, materialized views, foreign tables),
--               sequence, extension relation, extension sequence,
--               default tables, default sequences (the migrator's default
--               privileges in that schema), type (a type or domain). A
--               column's grant is allowed what its relation is. Functions:
--               lib/runtime-function-grants.txt. Every other ACL — the system
--               catalogues, parameters, tablespaces, languages, large objects,
--               foreign-data wrappers and servers — allows nothing beyond its
--               built-in privileges (runtime-acl-entries.sql).
--   object      `schema.name`, unquoted (a type's too); `schema.*` is every
--               relation (every sequence) of that schema; a schema name for
--               `schema` and the two default classes; `*` for the database
--               and extensions.
--   privileges  as aclexplode() spells them. runtime-forbidden.sql caps each
--               class (relations SELECT, INSERT, UPDATE, DELETE; sequences
--               USAGE, SELECT; …) and reports a row that asks for more.
--
-- Nothing else is allowed: not a partition the row did not name, not a grant
-- option, not a right reached through PUBLIC or a role the runtime role is a
-- member of. Derived from the migrations named beside each policy; a new table
-- in a `migration` or `audit` policy needs its row here AND its GRANT in the
-- migration, or the check fails on a fresh bootstrap.
-- -----------------------------------------------------------------------------
SELECT policy, class, object, privileges FROM (VALUES
  -- Every policy: CONNECT, nothing more on the database; an extension's
  -- relations and sequences are read-only (PostGIS reads spatial_ref_sys).
  ('*', 'database', '*', ARRAY['CONNECT']),
  ('*', 'extension relation', '*', ARRAY['SELECT']),
  ('*', 'extension sequence', '*', ARRAY['SELECT']),

  -- default: DML on every table of `public` and nextval/currval on every
  -- sequence, now and — by the migrator's default privileges — later.
  -- lib/service-privilege-split.bash grants exactly these rows.
  ('default', 'schema', 'public', ARRAY['USAGE']),
  ('default', 'relation', 'public.*', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('default', 'sequence', 'public.*', ARRAY['USAGE', 'SELECT']),
  ('default', 'default tables', 'public', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('default', 'default sequences', 'public', ARRAY['USAGE', 'SELECT']),

  -- supplier: 20260926130000_supplier_runtime_privileges and
  -- 20260926140000_performance_consumer_facts. No sequence.
  ('supplier', 'schema', 'public', ARRAY['USAGE']),
  ('supplier', 'relation', 'public.supplier', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('supplier', 'relation', 'public.supplier_capability', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('supplier', 'relation', 'public.qualification', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('supplier', 'relation', 'public.qualification_evidence', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('supplier', 'relation', 'public.suspension', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('supplier', 'relation', 'public.outbox_message', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('supplier', 'relation', 'public.outbox_stream_sequence', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('supplier', 'relation', 'public.processed_event', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('supplier', 'relation', 'public.performance_formula_version', ARRAY['SELECT', 'INSERT', 'UPDATE']),
  ('supplier', 'relation', 'public.performance_formula_weight', ARRAY['SELECT', 'INSERT']),
  ('supplier', 'relation', 'public.performance_event', ARRAY['SELECT', 'INSERT']),
  ('supplier', 'relation', 'public.performance_score_snapshot', ARRAY['SELECT', 'INSERT']),
  ('supplier', 'relation', 'public.performance_score_component', ARRAY['SELECT', 'INSERT']),
  ('supplier', 'relation', 'public.performance_score_source_event', ARRAY['SELECT', 'INSERT']),
  ('supplier', 'relation', 'public.performance_concluded_outcome', ARRAY['SELECT', 'INSERT']),

  -- analytics: 20261024120000_baseline_metric, 20261024130000_analytics_runtime_privileges,
  -- 20261029120000_projection_coverage. The baseline is read-only; no sequence
  -- (baseline_metric_version_seq is the migrator's).
  ('analytics', 'schema', 'public', ARRAY['USAGE']),
  ('analytics', 'relation', 'public.baseline_metric', ARRAY['SELECT']),
  ('analytics', 'relation', 'public.fact_maintenance', ARRAY['SELECT', 'INSERT']),
  ('analytics', 'relation', 'public.processed_event', ARRAY['SELECT', 'INSERT']),
  ('analytics', 'relation', 'public.projection_coverage', ARRAY['SELECT', 'INSERT']),

  -- audit: 20260908120000_init_audit, 20260910120000_audit_chain_head,
  -- 20261001110000_tender_evidence, 20261001130000_tender_receipt_pending,
  -- 20261003120000_payment_reconciliation_evidence, 20261102100000_rfq_evidence.
  -- Nothing in `public`, and
  -- nothing on an audit_event partition: the runtime role reaches the rows
  -- through the partitioned table only.
  ('audit', 'schema', 'audit', ARRAY['USAGE']),
  ('audit', 'relation', 'audit.audit_event', ARRAY['SELECT', 'INSERT']),
  ('audit', 'sequence', 'audit.audit_event_sequence_no_seq', ARRAY['USAGE', 'SELECT']),
  ('audit', 'relation', 'audit.processed_event', ARRAY['SELECT', 'INSERT']),
  ('audit', 'relation', 'audit.organization_ref', ARRAY['SELECT', 'INSERT', 'UPDATE']),
  ('audit', 'relation', 'audit.audit_chain_head', ARRAY['SELECT', 'INSERT', 'UPDATE']),
  ('audit', 'relation', 'audit.tender_receipt_link', ARRAY['SELECT', 'INSERT']),
  ('audit', 'relation', 'audit.bid_access_evidence', ARRAY['SELECT', 'INSERT']),
  ('audit', 'relation', 'audit.tender_receipt_pending', ARRAY['SELECT', 'INSERT', 'DELETE']),
  ('audit', 'relation', 'audit.payment_reconciliation_evidence', ARRAY['SELECT', 'INSERT']),
  ('audit', 'relation', 'audit.rfq_receipt_link', ARRAY['SELECT', 'INSERT']),
  ('audit', 'relation', 'audit.rfq_receipt_pending', ARRAY['SELECT', 'INSERT', 'DELETE']),
  -- 20260909093000_audit_org_hierarchy_projection, 20260910120000_audit_chain_head.
  ('audit', 'type', 'audit.organization_relation_state', ARRAY['USAGE']),
  ('audit', 'type', 'audit.audit_chain_scope', ARRAY['USAGE'])
) a(policy, class, object, privileges)
