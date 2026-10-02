/**
 * The role a service is connected as must be its runtime role, which owns
 * nothing (D-045, Codex review of #176).
 *
 * Since D-045 every service's database and every object in it belong to
 * `rasta_<svc>_migrator`, and the service connects as `rasta_<svc>`, which holds
 * DML only. A trigger, a CHECK or a revoked privilege binds only a role that
 * cannot remove it — so the split is a barrier only while the service really
 * is connected as the runtime role. `assertNoMigratorCredentials`
 * (`@rasta/config`) keeps the migrator's *variables* out of a service's
 * environment, but a `DATABASE_URL` that simply names the migrator, a
 * superuser or any role holding owner powers would pass it. So, before a
 * split service serves, relays or consumes anything, it asks the catalogue who
 * it is connected as ({@link assertRuntimeRole}) and refuses to start if that
 * role — directly or through membership of any kind (`pg_has_role … 'MEMBER'`,
 * which counts a grant WITH INHERIT FALSE too: such a member still can
 * `SET ROLE` to the owner; Codex round 3 on #176):
 *
 *   * is a superuser, or holds CREATEDB, CREATEROLE or BYPASSRLS;
 *   * is a migrator role by name (`current_user` or `session_user` ending in
 *     `_migrator`);
 *   * owns the database, any non-system schema, or any relation in one — the
 *     owner can DISABLE a trigger, DROP a constraint or a table;
 *   * holds CREATE on the database or on any non-system schema — it could make
 *     objects it would own;
 *   * is a member of any role that owns something here, is named `*_migrator`,
 *     or is superuser-capable (SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS).
 *
 * Infrastructure, not business logic: it decides whether a process may start,
 * never what it does. Each service runs it twice:
 *
 *   1. {@link preflightRuntimeRole}, first in `main.ts`'s `bootstrap()`, before
 *      `NestFactory.create` — on a short-lived connection of its own, so the
 *      refusal comes before Nest initialises a single provider. Nest runs every
 *      provider's `onModuleInit` before the root module's, and a consumer or a
 *      timer starts in its own: gated only in `AppModule`, it could take and
 *      commit work under an owner connection before the refusal (Codex on
 *      #178). A refused preflight rejects; `bootstrap().catch` exits 1.
 *   2. {@link assertRuntimeRole}, first in `AppModule.onModuleInit`, on the
 *      service's own connection — belt and braces, for an entry point that
 *      skips `main.ts`. Not in `PrismaService.onModuleInit`, because the
 *      integration suites open owner connections through that class on purpose.
 */

import { DemoSeedRefusedError } from '@rasta/config';

/** The one raw-SQL method every generated Prisma client has. */
export interface RuntimeRoleQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): PromiseLike<T>;
}

/** What the catalogue says about the connected role. */
export interface ConnectedRoleFacts {
  role: string;
  sessionRole: string;
  database: string;
  superuser: boolean;
  createDb: boolean;
  createRole: boolean;
  bypassRls: boolean;
  ownsDatabase: boolean;
  ownedSchemas: string[];
  ownsRelationIn: string[];
  createOnDatabase: boolean;
  createOnSchemas: string[];
  /** Roles it is a member of — SET or INHERIT, either — that are owners or superuser-capable. */
  memberOf: string[];
}

/** Read by {@link assertRuntimeRole}; exported so a live test runs exactly this. */
export const CONNECTED_ROLE_SQL = `
  WITH user_ns AS (
    SELECT n.oid, n.nspname, n.nspowner FROM pg_namespace n
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
  )
  SELECT current_user::text AS role,
         session_user::text AS "sessionRole",
         current_database()::text AS database,
         r.rolsuper AS superuser,
         r.rolcreatedb AS "createDb",
         r.rolcreaterole AS "createRole",
         r.rolbypassrls AS "bypassRls",
         EXISTS (SELECT 1 FROM pg_database d
                  WHERE d.datname = current_database()
                    AND pg_has_role(current_user, d.datdba, 'MEMBER')) AS "ownsDatabase",
         ARRAY(SELECT n.nspname::text FROM user_ns n
                WHERE pg_has_role(current_user, n.nspowner, 'MEMBER')
                ORDER BY 1) AS "ownedSchemas",
         ARRAY(SELECT DISTINCT n.nspname::text FROM pg_class c JOIN user_ns n ON n.oid = c.relnamespace
                WHERE pg_has_role(current_user, c.relowner, 'MEMBER')
                ORDER BY 1) AS "ownsRelationIn",
         has_database_privilege(current_database(), 'CREATE') AS "createOnDatabase",
         ARRAY(SELECT n.nspname::text FROM user_ns n
                WHERE has_schema_privilege(n.oid, 'CREATE')
                ORDER BY 1) AS "createOnSchemas",
         ARRAY(SELECT m.rolname::text FROM pg_roles m
                WHERE m.rolname <> current_user
                  AND pg_has_role(current_user, m.oid, 'MEMBER')
                  AND (m.rolsuper OR m.rolcreatedb OR m.rolcreaterole OR m.rolbypassrls
                       OR m.rolname LIKE '%\\_migrator'
                       OR EXISTS (SELECT 1 FROM pg_database d
                                   WHERE d.datname = current_database() AND d.datdba = m.oid)
                       OR EXISTS (SELECT 1 FROM user_ns n WHERE n.nspowner = m.oid)
                       OR EXISTS (SELECT 1 FROM pg_class c JOIN user_ns n ON n.oid = c.relnamespace
                                   WHERE c.relowner = m.oid))
                ORDER BY 1) AS "memberOf"
    FROM pg_roles r
   WHERE r.rolname = current_user`;

/** Every reason the connected role may not run a service; empty when it may. */
export function connectedRoleProblems(facts: ConnectedRoleFacts): string[] {
  const problems: string[] = [];
  if (facts.superuser) problems.push('is a superuser');
  for (const name of new Set([facts.role, facts.sessionRole])) {
    if (/_migrator$/.test(name)) problems.push(`is a migrator role (${name})`);
  }
  if (facts.createDb) problems.push('holds CREATEDB');
  if (facts.createRole) problems.push('holds CREATEROLE');
  if (facts.bypassRls) problems.push('holds BYPASSRLS');
  if (facts.ownsDatabase) problems.push(`can act as the owner of database ${facts.database}`);
  for (const schema of facts.ownedSchemas) {
    problems.push(`can act as the owner of schema ${schema}`);
  }
  for (const schema of facts.ownsRelationIn) {
    problems.push(`can act as the owner of a relation in schema ${schema}`);
  }
  if (facts.createOnDatabase) problems.push(`holds CREATE on database ${facts.database}`);
  for (const schema of facts.createOnSchemas) problems.push(`holds CREATE on schema ${schema}`);
  for (const role of facts.memberOf) {
    problems.push(
      `is a member of ${role}, an owner or superuser-capable role it could SET ROLE to`,
    );
  }
  return problems;
}

/** Thrown at startup when a service is connected as anything but its runtime role. */
export class RuntimeRoleRefusedError extends Error {
  constructor(
    readonly service: string,
    readonly facts: ConnectedRoleFacts,
    readonly problems: readonly string[],
    runtimeVariable: string,
  ) {
    super(
      `${service} refuses to start: it is connected as ${facts.role}, which ` +
        `${problems.join(', ')}. Only its runtime role (${runtimeVariable}) may run the ` +
        'service; a migrator or any owner is for migration tooling only ' +
        '(docs/runbooks/db-role-split.md, D-045).',
    );
    this.name = 'RuntimeRoleRefusedError';
  }
}

export interface AssertRuntimeRoleOptions {
  /** The service's name, for the error. */
  service: string;
  /** The variable the runtime URL comes from, e.g. `DATABASE_URL_CONSTRUCTION`. */
  runtimeVariable: string;
}

/**
 * Reads {@link CONNECTED_ROLE_SQL} and throws {@link RuntimeRoleRefusedError}
 * if the connected role could act as an owner. Returns the facts when it may
 * run, so the caller can log who it is connected as.
 */
export async function assertRuntimeRole(
  client: RuntimeRoleQueryClient,
  { service, runtimeVariable }: AssertRuntimeRoleOptions,
): Promise<ConnectedRoleFacts> {
  const rows = await client.$queryRawUnsafe<ConnectedRoleFacts[]>(CONNECTED_ROLE_SQL);
  const facts = rows[0];
  if (!facts) throw new Error(`${service} could not read the role it is connected as`);
  const problems = connectedRoleProblems(facts);
  if (problems.length > 0) {
    throw new RuntimeRoleRefusedError(service, facts, problems, runtimeVariable);
  }
  return facts;
}

/** A client {@link preflightRuntimeRole} can open, ask, and close. */
export interface RuntimeRolePreflightClient extends RuntimeRoleQueryClient {
  $disconnect(): PromiseLike<void>;
}

/**
 * The startup gate, before Nest builds anything: opens a client on the
 * service's runtime URL (`open`, typically `new PrismaClient({ datasources })`),
 * runs {@link assertRuntimeRole} on it and closes it whatever the outcome.
 * Rejects with {@link RuntimeRoleRefusedError} when the connected role could act
 * as an owner — and with the connection error when it cannot connect at all,
 * so nothing starts on a database it cannot vouch for.
 */
export async function preflightRuntimeRole(
  open: () => RuntimeRolePreflightClient,
  options: AssertRuntimeRoleOptions,
): Promise<ConnectedRoleFacts> {
  const client = open();
  try {
    return await assertRuntimeRole(client, options);
  } finally {
    await client.$disconnect();
  }
}

/**
 * {@link preflightRuntimeRole} for a demo seed (Codex round 2 on #177): the
 * first time a seed touches its database — before the seed guard's
 * disposable-marker probe (`assertDemoSeedDatabase`, @rasta/config) and long
 * before it writes. A refusal is the seed guard's refusal,
 * `DemoSeedRefusedError` ("Refusing to seed <service>: …"), so every way a seed
 * stops reads the same and scripts/verify-seed-guard.mjs can tell a refusal
 * from a crash: an owner is named with what it could do (roles and objects,
 * never the URL); a database that cannot be asked at all is refused without
 * echoing the driver's error.
 */
export async function assertDemoSeedRuntimeRole(
  open: () => RuntimeRolePreflightClient,
  options: AssertRuntimeRoleOptions,
): Promise<void> {
  try {
    await preflightRuntimeRole(open, options);
  } catch (error) {
    throw new DemoSeedRefusedError(options.service, [
      error instanceof RuntimeRoleRefusedError
        ? `it is connected as ${error.facts.role}, which ${error.problems.join(', ')}; ` +
          `a seed writes only as the runtime role (${options.runtimeVariable})`
        : 'the role the target database connects as could not be checked',
    ]);
  }
}
