import { createSystemContext, isRastaError, runWithContext } from '@rasta/nest-common';
import type { PrismaService } from '../prisma/prisma.service';
import { IdempotencyStore, idempotentRequest, type IdempotencyEnv } from './idempotency';

/**
 * FU-172 (PR-844 r1 F1): a replay is decided by the same deadline decision as an admission, on a
 * database clock read AFTER every wait the replay made — never on the reading taken before it.
 *
 * The waits the reviewer executed, on a store whose Prisma is a fake and whose database clock moves
 * while the wait lasts: the duplicate insert (the P2002 path) and the read of the stored row — plus
 * the replay guard, the last wait before the stored body is returned. The request started before
 * H, so this replica's pre-check passes; past H the replay must be `REPLAY_WINDOW_CLOSED`, with
 * nothing returned, nothing written and no work run.
 */

const ENDPOINT = 'POST /v1/demand-requests';
const UNIQUE = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
const BODY = { productId: 'PRD_1', quantity: 3 };
const STORED = { id: 'DMD_original' };
const ENV: IdempotencyEnv = {
  PROCUREMENT_IDEMPOTENCY_TTL_HOURS: 24,
  PROCUREMENT_IDEMPOTENCY_CLAIM_LEASE_SECONDS: 120,
  PROCUREMENT_CLOCK_SKEW_SECONDS: 30,
};

/** Where the replay waits — the database clock reads `afterWait` once that wait has ended. */
type Wait = 'insert' | 'read' | 'guard';

const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(
    createSystemContext({ correlationId: 'c', organizationId: 'ORG_X', callerService: 't' }),
    fn,
  );

async function replay(wait: Wait, afterWait: (deadline: number) => number, withDeadline = true) {
  const deadline = Date.now() + 60_000;
  let databaseNow = Date.now();
  const waited = (at: Wait) => {
    if (at === wait) databaseNow = afterWait(deadline);
  };
  const writes: string[] = [];
  const clockReadings: number[] = [];

  // Built below; the fakes reach it lazily (the stored row is hashed by the store itself).
  const built: { store?: IdempotencyStore } = {};
  const self = (): IdempotencyStore => built.store!;
  const delegate = {
    create: jest.fn(async () => {
      waited('insert');
      throw UNIQUE;
    }),
    findFirst: jest.fn(async () => {
      waited('read');
      return {
        requestHash: self().hash(BODY),
        state: 'COMPLETED',
        responseStatus: 201,
        responseBody: STORED,
        expiresAt: new Date(Date.now() + 3_600_000),
      };
    }),
    updateMany: jest.fn(async () => {
      writes.push('updateMany');
      return { count: 1 };
    }),
    deleteMany: jest.fn(async () => {
      writes.push('deleteMany');
      return { count: 1 };
    }),
  };
  const client = {
    idempotencyKey: delegate,
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn(async () => {
      writes.push('executeRaw');
      return 0;
    }),
  };
  const prisma = {
    client,
    transaction: jest.fn((fn: (tx: typeof client) => Promise<unknown>) => fn(client)),
  } as unknown as PrismaService;
  const clock = {
    now: async () => {
      clockReadings.push(databaseNow);
      return new Date(databaseNow);
    },
  };
  const store = new IdempotencyStore(prisma, ENV, clock);
  built.store = store;

  const work = jest.fn();
  const stillVisible = jest.fn(async () => waited('guard'));
  const request = idempotentRequest({
    'idempotency-key': 'key-abcdefgh',
    ...(withDeadline ? { 'idempotency-replay-deadline': String(deadline) } : {}),
  });
  const outcome = await inTenant(() =>
    store.execute(ENDPOINT, request, BODY, 201, work, stillVisible),
  ).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { deadline, outcome, work, writes, clockReadings, stillVisible };
}

describe('a replay is decided after its waits, on a fresh database clock (FU-172)', () => {
  it.each<[Wait]>([['insert'], ['read'], ['guard']])(
    'replay-%s-wait: started before H, the wait ends at H + 1 ms → 409 REPLAY_WINDOW_CLOSED, nothing returned',
    async (wait) => {
      // The reviewer's counterexample: timePastDeadlineMs = 1.
      const r = await replay(wait, (deadline) => deadline + 1);

      expect(r.outcome.ok).toBe(false);
      const error = r.outcome.ok ? undefined : r.outcome.error;
      expect(isRastaError(error) && error.code).toBe('REPLAY_WINDOW_CLOSED');
      // Decided on the one reading taken after every wait — not on one taken before.
      expect(r.clockReadings).toEqual([r.deadline + 1]);
      expect(r.work).not.toHaveBeenCalled();
      expect(r.writes).toEqual([]);
    },
  );

  it.each<[Wait]>([['insert'], ['read'], ['guard']])(
    'replay-%s-wait ending exactly at H replays the stored response (equality is allowed)',
    async (wait) => {
      const r = await replay(wait, (deadline) => deadline);

      expect(r.outcome).toEqual({ ok: true, value: { result: STORED, executed: false } });
      expect(r.clockReadings).toEqual([r.deadline]);
      expect(r.work).not.toHaveBeenCalled();
      expect(r.writes).toEqual([]);
    },
  );

  it('a replay without a deadline reads no clock and is answered as before', async () => {
    const r = await replay('read', (deadline) => deadline + 1, false);

    expect(r.outcome).toEqual({ ok: true, value: { result: STORED, executed: false } });
    expect(r.clockReadings).toEqual([]);
  });
});
