import { inspect } from 'node:util';
import {
  CONNECTED_ROLE_SQL,
  RuntimeRoleRefusedError,
  assertDemoSeedRuntimeRole,
  assertRuntimeRole,
  connectedRoleProblems,
  preflightRuntimeRole,
  RuntimeRoleUnverifiedError,
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

describe('the preflight, before Nest builds anything (Codex on #178)', () => {
  const opened = (facts: ConnectedRoleFacts | undefined, failWith?: Error) => {
    const state = { disconnected: 0 };
    const open = () => ({
      $queryRawUnsafe: <T>() =>
        failWith ? Promise.reject(failWith) : Promise.resolve((facts ? [facts] : []) as T),
      $disconnect: () => {
        state.disconnected += 1;
        return Promise.resolve();
      },
    });
    return { open, state };
  };

  it('lets the runtime role through, and closes its connection', async () => {
    const { open, state } = opened(runtime);
    await expect(preflightRuntimeRole(open, options)).resolves.toEqual(runtime);
    expect(state.disconnected).toBe(1);
  });

  it('refuses an owner, and still closes its connection', async () => {
    const { open, state } = opened({ ...runtime, memberOf: ['rasta_construction_migrator'] });
    await expect(preflightRuntimeRole(open, options)).rejects.toBeInstanceOf(
      RuntimeRoleRefusedError,
    );
    expect(state.disconnected).toBe(1);
  });

  it('fails closed when it cannot ask at all — by the variable and the code, never the client text', async () => {
    // Prisma's P1000 names the user it connected as (#385 r6): here the
    // username sentinel of scripts/refusal-probes.mjs, and the host.
    const p1000 = Object.assign(
      new Error(
        'Authentication failed against database server at `db.invalid`, the provided database ' +
          'credentials for `private-sentinel-79` are not valid.',
      ),
      { name: 'PrismaClientInitializationError', errorCode: 'P1000' },
    );
    const { open, state } = opened(undefined, p1000);
    const refusal = await preflightRuntimeRole(open, options).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RuntimeRoleUnverifiedError);
    expect((refusal as Error).message).toBe(
      `${options.runtimeVariable}: the connected role could not be checked (code P1000); ` +
        "the database client's own error is withheld",
    );
    expect((refusal as Error).cause).toBeUndefined();
    expect(inspect(refusal, { showHidden: true, depth: 10 })).not.toMatch(/sentinel|db\.invalid/);
    expect(state.disconnected).toBe(1);
  });

  it('a code that is not shaped like one is not repeated either', async () => {
    const odd = Object.assign(new Error('x'), { code: 'private-sentinel-79' });
    const { open } = opened(undefined, odd);
    await expect(preflightRuntimeRole(open, options)).rejects.toThrow('(code unknown)');
  });
});

describe('a demo seed refuses an owner as the seed guard does (Codex round 2 on #177)', () => {
  const seed = { service: 'identity-service', runtimeVariable: 'DATABASE_URL_IDENTITY' };
  const opener = (answer: () => Promise<unknown>) => () => ({
    $queryRawUnsafe: <T>() => answer() as Promise<T>,
    $disconnect: () => Promise.resolve(),
  });

  it('lets the runtime role through', async () => {
    await expect(
      assertDemoSeedRuntimeRole(
        opener(() => Promise.resolve([runtime])),
        seed,
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses the migrator with the guard's refusal, naming the role and what it owns", async () => {
    const migrator = { ...runtime, role: 'rasta_identity_migrator', ownsDatabase: true };
    const error = await assertDemoSeedRuntimeRole(
      opener(() => Promise.resolve([migrator])),
      seed,
    ).catch((e: unknown) => e);
    expect((error as Error).name).toBe('DemoSeedRefusedError');
    expect((error as Error).message).toMatch(
      /^Refusing to seed identity-service: it is connected as rasta_identity_migrator, which is a migrator role/,
    );
    expect((error as Error).message).toMatch(/DATABASE_URL_IDENTITY/);
  });

  it('refuses a database it cannot ask, without echoing the driver error', async () => {
    const error = await assertDemoSeedRuntimeRole(
      opener(() => Promise.reject(new Error('connect ECONNREFUSED postgresql://u:secret@h:1/db'))),
      seed,
    ).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(
      /^Refusing to seed identity-service: the role the target database connects as could not be checked/,
    );
    expect((error as Error).message).not.toMatch(/secret|ECONNREFUSED/);
  });
});
