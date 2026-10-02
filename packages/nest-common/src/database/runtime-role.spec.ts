import {
  CONNECTED_ROLE_SQL,
  RuntimeRoleRefusedError,
  assertRuntimeRole,
  connectedRoleProblems,
  type ConnectedRoleFacts,
  type RuntimeRoleQueryClient,
} from './runtime-role';

const runtime: ConnectedRoleFacts = {
  role: 'rasta_construction',
  sessionRole: 'rasta_construction',
  database: 'rasta_construction',
  superuser: false,
  createDb: false,
  createRole: false,
  bypassRls: false,
  ownsDatabase: false,
  ownedSchemas: [],
  ownsRelationIn: [],
  createOnDatabase: false,
  createOnSchemas: [],
  memberOf: [],
};

const client = (facts: ConnectedRoleFacts | undefined): RuntimeRoleQueryClient => ({
  $queryRawUnsafe: <T>() => Promise.resolve((facts ? [facts] : []) as T),
});

const options = { service: 'construction-service', runtimeVariable: 'DATABASE_URL_CONSTRUCTION' };

describe('a service runs only as its runtime role (D-045)', () => {
  it('lets the runtime role through and returns what it read', async () => {
    expect(connectedRoleProblems(runtime)).toEqual([]);
    await expect(assertRuntimeRole(client(runtime), options)).resolves.toEqual(runtime);
  });

  it('refuses the migrator, by name and by what it owns', async () => {
    const migrator: ConnectedRoleFacts = {
      ...runtime,
      role: 'rasta_construction_migrator',
      sessionRole: 'rasta_construction_migrator',
      createDb: true,
      ownsDatabase: true,
      ownedSchemas: ['public'],
      ownsRelationIn: ['public'],
      createOnDatabase: true,
      createOnSchemas: ['public'],
    };
    expect(connectedRoleProblems(migrator)).toEqual([
      'is a migrator role (rasta_construction_migrator)',
      'holds CREATEDB',
      'can act as the owner of database rasta_construction',
      'can act as the owner of schema public',
      'can act as the owner of a relation in schema public',
      'holds CREATE on database rasta_construction',
      'holds CREATE on schema public',
    ]);
    const error = await assertRuntimeRole(client(migrator), options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeRoleRefusedError);
    expect((error as Error).message).toMatch(
      /construction-service refuses to start: it is connected as rasta_construction_migrator/,
    );
    expect((error as Error).message).toMatch(/DATABASE_URL_CONSTRUCTION/);
  });

  it('refuses a session that SET ROLE away from a migrator login', () => {
    expect(connectedRoleProblems({ ...runtime, sessionRole: 'rasta_economic_migrator' })).toEqual([
      'is a migrator role (rasta_economic_migrator)',
    ]);
  });

  it('refuses a superuser, and each owner power on its own', () => {
    expect(connectedRoleProblems({ ...runtime, role: 'rasta', superuser: true })).toEqual([
      'is a superuser',
    ]);
    expect(connectedRoleProblems({ ...runtime, bypassRls: true })).toEqual(['holds BYPASSRLS']);
    expect(connectedRoleProblems({ ...runtime, createRole: true })).toEqual(['holds CREATEROLE']);
    expect(connectedRoleProblems({ ...runtime, ownsRelationIn: ['audit'] })).toEqual([
      'can act as the owner of a relation in schema audit',
    ]);
    expect(connectedRoleProblems({ ...runtime, createOnSchemas: ['audit'] })).toEqual([
      'holds CREATE on schema audit',
    ]);
  });

  it('refuses a member of the migrator even WITH INHERIT FALSE — it could SET ROLE (Codex round 3)', () => {
    expect(
      connectedRoleProblems({ ...runtime, memberOf: ['rasta_construction_migrator'] }),
    ).toEqual([
      'is a member of rasta_construction_migrator, an owner or superuser-capable role it could SET ROLE to',
    ]);
  });

  it('fails closed when the catalogue says nothing', async () => {
    await expect(assertRuntimeRole(client(undefined), options)).rejects.toThrow(
      /could not read the role it is connected as/,
    );
  });

  it('asks about any membership, every non-system schema, and both user names', () => {
    for (const fragment of [
      'session_user',
      "pg_has_role(current_user, d.datdba, 'MEMBER')",
      "pg_has_role(current_user, n.nspowner, 'MEMBER')",
      "pg_has_role(current_user, c.relowner, 'MEMBER')",
      "pg_has_role(current_user, m.oid, 'MEMBER')",
      "has_database_privilege(current_database(), 'CREATE')",
      "has_schema_privilege(n.oid, 'CREATE')",
      'rolbypassrls',
    ]) {
      expect(CONNECTED_ROLE_SQL).toContain(fragment);
    }
    // USAGE ignores a membership granted WITH INHERIT FALSE, which still allows SET ROLE.
    expect(CONNECTED_ROLE_SQL).not.toContain("'USAGE'");
  });
});
