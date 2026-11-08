import { isRastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import type { ExtendedPrismaClient, PrismaService } from '../prisma/prisma.service';
import type { ConstructionEnv } from '../config/env';
import { IdempotencyStore } from './idempotency';

/**
 * FU-172 (PR-844 r1 F1, the construction sibling of the pre-existing stale reading): a replay is
 * decided by the same deadline decision as an admission, on a database clock read AFTER every wait
 * the replay made — never on `nowMs`, read before them.
 *
 * Two waits, on a store whose Prisma is a fake and whose database clock moves while the wait lasts:
 * the duplicate insert (the P2002 path) and the read of the stored row. The request started before
 * H — this replica's pre-checks pass — and, past H, the replay must be `REPLAY_WINDOW_CLOSED` with
 * nothing returned and nothing written.
 */

const ENDPOINT = 'POST /v1/projects';
const UNIQUE = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
const BODY = { name: 'Village school' };
const STORED = { id: 'PRJ_original' };

type Wait = 'insert' | 'read';

class FakeClockStore extends IdempotencyStore {
  databaseNow = Date.now();
  readonly readings: number[] = [];

  protected override databaseInstant(_tx: ExtendedPrismaClient): Promise<Date> {
    this.readings.push(this.databaseNow);
    return Promise.resolve(new Date(this.databaseNow));
  }
}

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  const context = {
    requestId: 'r',
    correlationId: 'c',
    authType: 'USER',
    organizationId: 'ORG_A',
    userId: 'USR_1',
    roles: [],
    startedAt: Date.now(),
  } as unknown as RequestContext;
  return runWithContext(context, fn);
}

/**
 * A replay of a completed response with deadline `deadline`, whose `wait` ends with the database
 * clock at `afterWait`. `headers.request`: this retry sends `deadline` as its header;
 * `headers.stored`: the row carries it as its stored deadline.
 */
async function replay(
  wait: Wait,
  afterWait: (deadline: number) => number,
  headers: { request: boolean; stored: boolean } = { request: true, stored: true },
) {
  const deadline = Date.now() + 60_000;
  const writes: string[] = [];
  // Built below; the fakes reach it lazily (the stored row is hashed by the store itself).
  const built: { store?: FakeClockStore } = {};
  const self = (): FakeClockStore => built.store!;
  const waited = (at: Wait) => {
    if (at === wait) self().databaseNow = afterWait(deadline);
  };
  const delegate = {
    create: jest.fn(async () => {
      waited('insert');
      throw UNIQUE;
    }),
    findUnique: jest.fn(async () => {
      waited('read');
      return {
        requestHash: self().hash(BODY),
        claimToken: 'original',
        state: 'COMPLETED',
        expiresAt: new Date(Date.now() + 3_600_000),
        responseBody: STORED,
        replayDeadlineAt: headers.stored ? new Date(deadline) : null,
      };
    }),
    deleteMany: jest.fn(async () => {
      writes.push('deleteMany');
      return { count: 1 };
    }),
  };
  const tx = { idempotencyKey: delegate, $queryRaw: jest.fn().mockResolvedValue([]) };
  const prisma = {
    client: { idempotencyKey: delegate },
    transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const env = {
    CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: 24,
    CONSTRUCTION_CLOCK_SKEW_SECONDS: 30,
  } as ConstructionEnv;
  const store = new FakeClockStore(prisma, env);
  built.store = store;

  const work = jest.fn();
  const outcome = await inTenant(() =>
    store.execute(
      ENDPOINT,
      'key-abcdefgh',
      BODY,
      201,
      work,
      undefined,
      headers.request ? deadline : undefined,
    ),
  ).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { deadline, outcome, work, writes, readings: store.readings };
}

describe('a replay is decided after its waits, on a fresh database clock (FU-172)', () => {
  it.each<[Wait]>([['insert'], ['read']])(
    'replay-%s-wait: started before H, the wait ends at H + 1 ms → 409 REPLAY_WINDOW_CLOSED, nothing returned',
    async (wait) => {
      const r = await replay(wait, (deadline) => deadline + 1);

      expect(r.outcome.ok).toBe(false);
      const error = r.outcome.ok ? undefined : r.outcome.error;
      expect(isRastaError(error) && error.code).toBe('REPLAY_WINDOW_CLOSED');
      expect(r.readings).toEqual([r.deadline + 1]);
      expect(r.work).not.toHaveBeenCalled();
      expect(r.writes).toEqual([]);
    },
  );

  it.each<[Wait]>([['insert'], ['read']])(
    'replay-%s-wait ending exactly at H replays the stored response (equality is allowed)',
    async (wait) => {
      const r = await replay(wait, (deadline) => deadline);

      expect(r.outcome).toEqual({ ok: true, value: { result: STORED, executed: false } });
      expect(r.readings).toEqual([r.deadline]);
      expect(r.writes).toEqual([]);
    },
  );

  it('the stored deadline binds a retry that sent none: refused past it after the wait', async () => {
    const r = await replay('read', (deadline) => deadline + 1, { request: false, stored: true });

    expect(r.outcome.ok).toBe(false);
    const error = r.outcome.ok ? undefined : r.outcome.error;
    expect(isRastaError(error) && error.code).toBe('REPLAY_WINDOW_CLOSED');
  });

  it('a replay with no deadline anywhere reads no clock and is answered as before', async () => {
    const r = await replay('read', (deadline) => deadline + 1, { request: false, stored: false });

    expect(r.outcome).toEqual({ ok: true, value: { result: STORED, executed: false } });
    expect(r.readings).toEqual([]);
  });
});
