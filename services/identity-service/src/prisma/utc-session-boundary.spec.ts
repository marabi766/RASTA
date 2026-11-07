import { createSafePrismaClient, UTC_SESSION_CHECK_SQL } from '@rasta/nest-common';
import { Prisma, PrismaClient } from '../generated/prisma';

/**
 * PR #906 r1 F1: no client this boundary exposes runs a statement without the UTC check.
 *
 * The reviewer's probe, kept: the real generated client, its real extensions, batches and
 * interactive transactions, and Prisma's real engine wrapper. Only the native engine under it is
 * replaced, by a backend outside UTC: it refuses the check and counts every other statement it
 * would have executed. `checks` counts the check reaching the engine, so a refusal for any other
 * reason (the extension's, or a TypeError) still says `writes = 0` and `checks = 0`.
 */
const URL = 'postgresql://probe:probe@127.0.0.1:1/probe?schema=public';
const WRITE = 'UPDATE registration_intake SET attempts = attempts + 1';

/** The session refuses, exactly as `UTC_SESSION_CHECK_SQL` does on a backend in Tehran. */
const REFUSED = JSON.stringify({
  errors: [
    {
      error: 'raw',
      user_facing_error: {
        is_panic: false,
        message: 'Raw query failed. Message: `session TimeZone is not UTC: Asia/Tehran`',
        error_code: 'P2010',
        meta: {},
      },
    },
  ],
});

interface Backend {
  checks: number;
  writes: number;
}

function open() {
  const backend: Backend = { checks: 0, writes: 0 };
  const isCheck = (statement: { query?: { arguments?: { query?: string } } }) =>
    statement.query?.arguments?.query === UTC_SESSION_CHECK_SQL;
  /** One statement. Answers REFUSED for the check; anything else "executes". */
  const run = (statement: object): string | null => {
    if (isCheck(statement)) {
      backend.checks += 1;
      return REFUSED;
    }
    backend.writes += 1;
    return null;
  };
  const native = {
    query: async (body: string) => {
      const request = JSON.parse(body) as { batch?: object[] };
      for (const statement of request.batch ?? [request]) {
        const answer = run(statement);
        if (answer) return answer;
      }
      return JSON.stringify(
        request.batch
          ? { batchResult: request.batch.map(() => ({ data: { executeRaw: 1 } })) }
          : { data: { executeRaw: 1 } },
      );
    },
    startTransaction: async () => JSON.stringify({ id: 'itx-1' }),
    commitTransaction: async () => '{}',
    rollbackTransaction: async () => '{}',
    disconnect: async () => undefined,
  };
  const raw = new PrismaClient({ datasources: { db: { url: URL } } });
  Object.assign((raw as unknown as { _engine: object })._engine, {
    libraryInstantiationPromise: Promise.resolve(),
    libraryStarted: true,
    engine: native,
  });
  const safe = createSafePrismaClient(() => raw, 'DATABASE_URL_IDENTITY');
  return { backend, raw, safe };
}

type Client = ReturnType<typeof open>['safe'];

/** The one raw statement of this spec, through whichever client a probe holds. */
const write = (client: unknown) => (client as Client).$executeRawUnsafe(WRITE);

/** The three ways to run a statement, through any client. */
const WAYS: ReadonlyArray<[string, (client: Client) => PromiseLike<unknown>]> = [
  ['autocommit', (client) => write(client)],
  ['batch', (client) => client.$transaction([write(client)])],
  ['interactive', (client) => client.$transaction((tx) => write(tx))],
];

const parentOf = (client: Client) => (client as unknown as { $parent: Client }).$parent;

describe('every client this boundary exposes runs the UTC check (PR #906 r1 F1)', () => {
  describe.each(WAYS)('%s', (_way, run) => {
    it('the protected control: the check runs and refuses, the write does not', async () => {
      const { backend, safe } = open();
      await expect(run(safe)).rejects.toThrow(/not in UTC/);
      expect(backend).toEqual({ checks: 1, writes: 0 });
    });

    it('an extended client: the same', async () => {
      const { backend, safe } = open();
      await expect(run(safe.$extends({}) as unknown as Client)).rejects.toThrow(/not in UTC/);
      expect(backend).toEqual({ checks: 1, writes: 0 });
    });

    it('the reviewer’s escape through $parent: refused, nothing written', async () => {
      const { backend, safe } = open();
      await expect((async () => run(parentOf(safe)))()).rejects.toThrow(/refused/);
      expect(backend.writes).toBe(0);
    });

    it('$parent of an extended client: refused, nothing written', async () => {
      const { backend, safe } = open();
      const extended = safe.$extends({}) as unknown as Client;
      await expect((async () => run(parentOf(extended)))()).rejects.toThrow(/refused/);
      expect(backend.writes).toBe(0);
    });

    it('the reviewer’s escape through a captured extension client: refused, nothing written', async () => {
      const { backend, safe } = open();
      let captured: Client | undefined;
      const capturing = (client: Client) => {
        captured = client;
        return client;
      };
      expect(() => (safe.$extends as (extension: unknown) => unknown)(capturing)).toThrow(
        /refused/,
      );
      expect(captured).toBeUndefined();
      expect(backend.writes).toBe(0);
    });

    it('Prisma.defineExtension with a function is the same refused form', async () => {
      const { backend, safe } = open();
      const form = Prisma.defineExtension((client) =>
        client.$extends({
          client: {
            write: () => run(client as unknown as Client),
          },
        }),
      );
      expect(() => (safe.$extends as (extension: unknown) => unknown)(form)).toThrow(/refused/);
      expect(backend.writes).toBe(0);
    });

    it('a client method of an extension runs on the checked client', async () => {
      const { backend, safe } = open();
      const extended = safe.$extends({
        client: {
          write() {
            return run(Prisma.getExtensionContext(this) as unknown as Client);
          },
        },
      });
      await expect(extended.write()).rejects.toThrow(/not in UTC/);
      expect(backend).toEqual({ checks: 1, writes: 0 });
    });

    it('$parent of a model, also through the extension context: refused, nothing written', async () => {
      const { backend, safe } = open();
      const extended = safe.$extends({
        model: {
          $allModels: {
            escape(this: unknown) {
              return run(
                (Prisma.getExtensionContext(this) as unknown as { $parent: Client }).$parent,
              );
            },
          },
        },
      });
      const model = safe.registrationIntake as unknown as { $parent: Client };
      await expect((async () => run(model.$parent))()).rejects.toThrow(/refused/);
      const viaContext = extended.registrationIntake as unknown as {
        escape(): PromiseLike<unknown>;
      };
      await expect((async () => viaContext.escape())()).rejects.toThrow(/refused/);
      expect(backend.writes).toBe(0);
    });
  });

  it.each(['_appliedParent', '_originalClient'])(
    'the private field behind $parent, %s: refused',
    (field) => {
      const { safe } = open();
      expect(() => Reflect.get(safe, field)).toThrow(/refused/);
      expect(() => Reflect.get(safe.$extends({}), field)).toThrow(/refused/);
    },
  );

  // Prisma's own composite proxy answers Object.prototype; `__proto__` read through it does not.
  it('the prototype of a client, which is the original client: not handed out', () => {
    const { raw, safe } = open();
    const extended = safe.$extends({});
    expect(Object.getPrototypeOf(extended)).not.toBe(raw);
    expect(Object.getPrototypeOf(extended)).toBe(Object.prototype);
    expect(() => Reflect.get(extended, '__proto__')).toThrow(/refused/);
  });

  it.each([null, undefined, 1, 'extension'])('$extends(%s) is refused', (form) => {
    const { safe } = open();
    expect(() => (safe.$extends as (extension: unknown) => unknown)(form)).toThrow(/refused/);
  });

  describe('being in a transaction is not proof it was checked', () => {
    it('a checked statement in a batch of a client without the check: refused, not written', async () => {
      const { backend, raw, safe } = open();
      await expect(raw.$transaction([write(safe)])).rejects.toThrow(/refused/);
      expect(backend).toEqual({ checks: 0, writes: 0 });
    });

    it('a model write in a batch of a client without the check: refused, not written', async () => {
      const { backend, raw, safe } = open();
      await expect(
        raw.$transaction([
          safe.registrationIntake.deleteMany({ where: { id: 'none' } }),
          write(safe),
        ]),
      ).rejects.toThrow(/refused/);
      expect(backend).toEqual({ checks: 0, writes: 0 });
    });

    it('an extension that swallows the check of an interactive transaction: refused', async () => {
      const { backend, safe } = open();
      const swallowing = safe.$extends({
        query: {
          $queryRawUnsafe: () => Promise.resolve([{ utc: 1 }]),
        },
      });
      await expect(swallowing.$transaction((tx) => write(tx))).rejects.toThrow(/refused/);
      expect(backend).toEqual({ checks: 0, writes: 0 });
    });

    it('an extension that rewrites the check of a batch: refused', async () => {
      const { backend, safe } = open();
      const rewriting = safe.$extends({
        query: {
          $queryRawUnsafe: ({ query }: { query: (args: unknown) => Promise<unknown> }) =>
            query(['SELECT 1']),
        },
      });
      await expect(rewriting.$transaction([write(rewriting)])).rejects.toThrow(/refused/);
      expect(backend).toEqual({ checks: 0, writes: 0 });
    });

    it('an interactive client’s $parent stays inside the transaction that was checked', async () => {
      const { backend, safe } = open();
      await expect(
        safe.$transaction((tx) => write((tx as unknown as { $parent: Client }).$parent)),
      ).rejects.toThrow(/not in UTC/);
      expect(backend).toEqual({ checks: 1, writes: 0 });
    });
  });

  it('a backend in UTC: every way works, and the check is hidden from the answer', async () => {
    const { raw, safe } = open();
    const engine = (raw as unknown as { _engine: { engine: { query: unknown } } })._engine.engine;
    const seen: string[] = [];
    engine.query = async (body: string) => {
      const request = JSON.parse(body) as {
        batch?: Array<{ query?: { arguments?: { query?: string } } }>;
      };
      const statements = request.batch ?? [
        request as { query?: { arguments?: { query?: string } } },
      ];
      for (const statement of statements) seen.push(statement.query?.arguments?.query ?? '');
      return JSON.stringify(
        request.batch
          ? { batchResult: request.batch.map(() => ({ data: { executeRaw: 1 } })) }
          : { data: { executeRaw: 1 } },
      );
    };
    await write(safe);
    await expect(safe.$transaction([write(safe)])).resolves.toHaveLength(1);
    await safe.$transaction(async (tx) => {
      await write(tx);
      await write(tx);
    });
    expect(seen).toEqual([
      UTC_SESSION_CHECK_SQL,
      WRITE,
      UTC_SESSION_CHECK_SQL,
      WRITE,
      UTC_SESSION_CHECK_SQL,
      WRITE,
      WRITE,
    ]);
  });
});
