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
  replication: false,
  ownsDatabase: false,
  ownedSchemas: [],
  ownsRelationIn: [],
  createOnDatabase: false,
  createOnSchemas: [],
  memberOf: [],
  timeZone: 'UTC',
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
    expect(connectedRoleProblems({ ...runtime, replication: true })).toEqual(['holds REPLICATION']);
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
      'r.rolreplication AS replication',
      'OR m.rolreplication',
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

describe('preflight requires bounded confirmed cleanup', () => {
  const secret = Object.assign(new Error('postgresql://private:secret@db.invalid/db'), {
    code: 'P1001',
  });
  const disconnect = jest.fn();
  const open =
    (mode = 'valid') =>
    () => ({
      $queryRawUnsafe: <T>() =>
        mode === 'connection'
          ? Promise.reject(secret)
          : Promise.resolve([{ ...runtime, superuser: mode === 'owner' }] as T),
      $disconnect: disconnect,
    });
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it.each([
    'reject',
    'throw',
    'undefined',
    'null',
    'non-callable',
    'getter',
    'then throws',
    'pending thenable',
  ])('refuses %s cleanup once with safe unconfirmed diagnostics', async (mode) => {
    disconnect.mockImplementation(() => {
      if (mode === 'reject') return Promise.reject(secret);
      if (mode === 'throw') throw secret;
      if (mode === 'undefined') return undefined;
      if (mode === 'null') return null;
      if (mode === 'non-callable') return { then: 1 };
      if (mode === 'pending thenable') return { then: () => undefined };
      if (mode === 'getter')
        return {
          get then() {
            throw secret;
          },
        };
      return {
        then() {
          throw secret;
        },
      };
    });
    const result = preflightRuntimeRole(open(), options).catch((e: unknown) => e);
    await jest.runAllTimersAsync();
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('close UNCONFIRMED');
    expect(inspect(error, { showHidden: true, depth: 10 })).not.toMatch(
      /secret|private|db\.invalid/,
    );
    expect((error as Error).cause).toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each(['owner', 'connection'])(
    'preserves primary %s refusal across rejecting, throwing, or pending cleanup',
    async (mode) => {
      for (const cleanup of ['reject', 'throw', 'pending']) {
        disconnect.mockImplementation(() => {
          if (cleanup === 'throw') throw secret;
          return cleanup === 'reject' ? Promise.reject(secret) : new Promise(() => undefined);
        });
        const result = preflightRuntimeRole(open(mode), options).catch((e: unknown) => e);
        await jest.runAllTimersAsync();
        const error = await result;
        expect(error).toBeInstanceOf(
          mode === 'owner' ? RuntimeRoleRefusedError : RuntimeRoleUnverifiedError,
        );
        if (mode === 'connection') expect((error as RuntimeRoleUnverifiedError).code).toBe('P1001');
        expect(inspect(error, { showHidden: true, depth: 10 })).not.toMatch(
          /secret|private|db\.invalid/,
        );
        expect(jest.getTimerCount()).toBe(0);
      }
    },
  );
  it('does not disconnect or claim cleanup when the factory never returns a handle', async () => {
    const error = await preflightRuntimeRole(() => {
      throw secret;
    }, options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeRoleUnverifiedError);
    expect((error as RuntimeRoleUnverifiedError).code).toBe('P1001');
    expect(disconnect).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each(['resolve', 'reject'])(
    'refuses pending cleanup and observes late %s without resuming startup',
    async (mode) => {
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      disconnect.mockReturnValue(
        new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      );
      const startup = jest.fn();
      const result = preflightRuntimeRole(open(), options).then(startup, (e: unknown) => e);
      await jest.advanceTimersByTimeAsync(22_999);
      expect(startup).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(1);
      const error = await result;
      expect((error as Error).message).toContain('close UNCONFIRMED');
      if (mode === 'resolve') resolve();
      else reject(secret);
      await jest.advanceTimersByTimeAsync(0);
      expect(startup).not.toHaveBeenCalled();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
  it('keeps demo seed cleanup refusal compatible and sanitized', async () => {
    disconnect.mockRejectedValue(secret);
    await expect(assertDemoSeedRuntimeRole(open(), options)).rejects.toThrow(
      'the role the target database connects as could not be checked',
    );
  });
});
