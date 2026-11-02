import { runUnscoped } from '@rasta/nest-common';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Everything the database does when a row is inserted into `table`, as
 * PostgreSQL's catalogue has it: what the relation is, its columns with their
 * defaults and generated expressions, every constraint and index by its
 * definition (not its name), every trigger — internal ones too — rule and
 * policy, and every object these depend on that is not the table itself. A
 * constraint, default or index expression is code: a CHECK that calls a
 * function runs that function on every insert, and what the function reads is
 * not in the definition, only in `dependencies`. So a test compares this
 * whole document to an approved one: anything not in it fails, whatever it is.
 */
export interface TableCatalogue {
  relation: Record<string, unknown>;
  columns: Array<Record<string, unknown>>;
  constraints: Array<{ name: string; definition: string }>;
  indexes: Array<{ definition: string; valid: boolean }>;
  triggers: string[];
  rules: string[];
  policies: string[];
  dependencies: Array<{ object: string; dependsOn: string; type: string }>;
}

export function readTableCatalogue(prisma: PrismaService, table: string): Promise<TableCatalogue> {
  return runUnscoped('test reads the table catalogue', async () => {
    const [row] = await prisma.client.$queryRaw<Array<{ catalogue: TableCatalogue }>>`
      WITH t AS (SELECT ${table}::regclass::oid AS oid)
      SELECT jsonb_build_object(
        'relation', (SELECT jsonb_build_object(
            'kind', c.relkind::text, 'persistence', c.relpersistence::text,
            'isPartition', c.relispartition,
            'isPartitioned', EXISTS (SELECT 1 FROM pg_partitioned_table p WHERE p.partrelid = c.oid),
            'parents', (SELECT count(*) FROM pg_inherits i WHERE i.inhrelid = c.oid),
            'children', (SELECT count(*) FROM pg_inherits i WHERE i.inhparent = c.oid),
            'hasSubclass', c.relhassubclass, 'ofType', c.reloftype <> 0,
            'options', to_jsonb(c.reloptions),
            'accessMethod', (SELECT amname FROM pg_am WHERE oid = c.relam),
            'rowSecurity', c.relrowsecurity, 'forcedRowSecurity', c.relforcerowsecurity,
            'publications', (SELECT count(*) FROM pg_publication_rel r WHERE r.prrelid = c.oid))
          FROM pg_class c WHERE c.oid = t.oid),
        'columns', (SELECT jsonb_agg(jsonb_build_object(
            'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
            'notNull', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid),
            'generated', a.attgenerated::text, 'identity', a.attidentity::text) ORDER BY a.attnum)
          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped),
        'constraints', (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'name', conname, 'definition', pg_get_constraintdef(oid)) ORDER BY conname), '[]')
          FROM pg_constraint WHERE conrelid = t.oid),
        'indexes', (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'definition', pg_get_indexdef(indexrelid), 'valid', indisvalid AND indisready)
            ORDER BY pg_get_indexdef(indexrelid)), '[]')
          FROM pg_index WHERE indrelid = t.oid),
        'triggers', (SELECT coalesce(jsonb_agg(tgname ORDER BY tgname), '[]')
          FROM pg_trigger WHERE tgrelid = t.oid),
        'rules', (SELECT coalesce(jsonb_agg(rulename ORDER BY rulename), '[]')
          FROM pg_rewrite WHERE ev_class = t.oid),
        'policies', (SELECT coalesce(jsonb_agg(polname ORDER BY polname), '[]')
          FROM pg_policy WHERE polrelid = t.oid),
        'dependencies', (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'object', pg_describe_object(d.classid, d.objid, d.objsubid),
            'dependsOn', pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid),
            'type', d.deptype::text)
            ORDER BY pg_describe_object(d.classid, d.objid, d.objsubid),
                     pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid)), '[]')
          FROM pg_depend d
          WHERE (d.classid, d.objid) IN (
                  SELECT 'pg_class'::regclass::oid, t.oid
                  UNION ALL SELECT 'pg_class'::regclass::oid, indexrelid FROM pg_index WHERE indrelid = t.oid
                  UNION ALL SELECT 'pg_constraint'::regclass::oid, oid FROM pg_constraint WHERE conrelid = t.oid
                  UNION ALL SELECT 'pg_attrdef'::regclass::oid, oid FROM pg_attrdef WHERE adrelid = t.oid
                  UNION ALL SELECT 'pg_trigger'::regclass::oid, oid FROM pg_trigger WHERE tgrelid = t.oid
                  UNION ALL SELECT 'pg_rewrite'::regclass::oid, oid FROM pg_rewrite WHERE ev_class = t.oid
                  UNION ALL SELECT 'pg_policy'::regclass::oid, oid FROM pg_policy WHERE polrelid = t.oid)
            AND NOT (d.refclassid = 'pg_class'::regclass AND d.refobjid = t.oid))
      ) AS catalogue FROM t`;
    return row!.catalogue;
  });
}
