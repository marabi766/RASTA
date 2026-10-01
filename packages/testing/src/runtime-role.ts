/**
 * Probes for a service's runtime database role (D-045).
 *
 * A database trigger, a CHECK constraint or a revoked privilege is a barrier
 * only against a role that cannot remove it, and a table's owner can. Since
 * D-045 each service's runtime role (`rasta_<svc>`) owns nothing and holds
 * DML only; `rasta_<svc>_migrator` owns the database
 * (infrastructure/docker/postgres/lib/service-privilege-split.bash). Each
 * service's `test/runtime-privileges.int-spec.ts` proves that with these
 * probes, run **as the runtime role**: every way to lift a guard must fail with
 * SQLSTATE 42501, and the role's rights on every table must be exactly DML.
 *
 * Test-only SQL against the catalogue; no service logic. The client is any
 * Prisma client — each service passes its own generated one.
 */

/** The two raw-SQL methods every generated Prisma client has. */
export interface RawSqlClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): PromiseLike<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): PromiseLike<T>;
}

/** How Prisma reports SQLSTATE 42501 — insufficient privilege. */
export const INSUFFICIENT_PRIVILEGE = /Code: `42501`/;

/** Who the client is connected as, and whether that role can act as an owner. */
export interface RuntimeRoleFacts {
  role: string;
  databaseOwner: boolean;
  ownsASchema: boolean;
  createDb: boolean;
  createRole: boolean;
  bypassRls: boolean;
}

export async function runtimeRoleFacts(client: RawSqlClient): Promise<RuntimeRoleFacts> {
  const [row] = await client.$queryRawUnsafe<RuntimeRoleFacts[]>(`
    SELECT current_user::text AS role,
           pg_has_role(current_user, d.datdba, 'USAGE') AS "databaseOwner",
           EXISTS (SELECT 1 FROM pg_namespace n
                    WHERE pg_has_role(current_user, n.nspowner, 'USAGE')
                      AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema')
             AS "ownsASchema",
           r.rolcreatedb AS "createDb",
           r.rolcreaterole AS "createRole",
           r.rolbypassrls AS "bypassRls"
      FROM pg_database d, pg_roles r
     WHERE d.datname = current_database() AND r.rolname = current_user`);
  if (!row) throw new Error('the connected role is not in pg_roles');
  return row;
}

/** Every user trigger on a table in `schema`, by table and name. */
export function schemaTriggers(
  client: RawSqlClient,
  schema = 'public',
): PromiseLike<{ table: string; trigger: string }[]> {
  return client.$queryRawUnsafe(
    `SELECT c.relname AS "table", t.tgname AS "trigger"
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relnamespace = $1::regnamespace
      ORDER BY 1, 2`,
    schema,
  );
}

/**
 * The connected role's table privileges on every table its migrations made in
 * `schema` — an extension's tables (postgis's `spatial_ref_sys`) excluded by
 * extension membership, never by name.
 */
export function tablePrivileges(
  client: RawSqlClient,
  schema = 'public',
): PromiseLike<{ table: string; privileges: string[] }[]> {
  return client.$queryRawUnsafe(
    `SELECT t.tablename AS "table",
            ARRAY(SELECT p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                                             'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
                   WHERE has_table_privilege(format('%I.%I', t.schemaname, t.tablename), p)
                   ORDER BY p) AS privileges
       FROM pg_tables t
      WHERE t.schemaname = $1
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
           WHERE d.classid = 'pg_class'::regclass
             AND d.objid = format('%I.%I', t.schemaname, t.tablename)::regclass
             AND d.deptype = 'e')
      ORDER BY 1`,
    schema,
  );
}

/** What the runtime role must hold on a table: DML, or nothing on the migration ledger. */
export const DML = Object.freeze(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
export const expectedTablePrivileges = (table: string): readonly string[] =>
  table === '_prisma_migrations' ? [] : DML;

/**
 * Statements that would lift or remove a guard on `table`, each of which the
 * runtime role must be refused. `trigger` names one of its triggers, when it
 * has one; a table without triggers is still guarded by its constraints and by
 * the table itself.
 */
export function liftAttempts(table: string, trigger?: string): string[] {
  const t = `"${table}"`;
  return [
    ...(trigger
      ? [`ALTER TABLE ${t} DISABLE TRIGGER "${trigger}"`, `DROP TRIGGER "${trigger}" ON ${t}`]
      : []),
    `ALTER TABLE ${t} DISABLE TRIGGER ALL`,
    `ALTER TABLE ${t} ADD COLUMN "d045_probe" integer`,
    `ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS "d045_none"`,
    `ALTER TABLE ${t} OWNER TO CURRENT_USER`,
    `DROP TABLE ${t}`,
    `TRUNCATE ${t}`,
  ];
}

/** Objects the runtime role must not be able to create, and `database`, which it must not alter. */
export function createAttempts(database: string): string[] {
  return [
    'CREATE TABLE "public"."d045_probe" (id integer)',
    'CREATE SCHEMA "d045_probe"',
    'CREATE FUNCTION "public"."d045_probe"() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
    `ALTER DATABASE "${database}" RENAME TO "d045_probe"`,
  ];
}
