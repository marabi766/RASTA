import { performance } from 'node:perf_hooks';
import * as clock from '../src/shared/clock';
import type { PrismaClient } from '../src/generated/prisma';
import { ReservationExpiry } from '../src/reservation/expiry';
import { ReservationRepository } from '../src/reservation/reservation.repository';
import { ReservationSweeper } from '../src/reservation/reservation.sweeper';
import { client, key, orgAdmin, seedStock, startApi, type ApiHarness } from './api-helpers';
import { cleanup, expectReconciled, newOrganizationId, runtimeClient } from './helpers';

// Only boundary tests below override the reading with a timestamp obtained from PostgreSQL.
// Default implementation, used by every real lock-wait proof, executes the production query.
jest.mock('../src/shared/clock', () => {
  const actual = jest.requireActual<typeof clock>('../src/shared/clock');
  return { ...actual, databaseClock: jest.fn(actual.databaseClock) };
});

/** Real row-lock waits, observed in PostgreSQL; no delay is used to guess when B started. */
describe('expiry decisions after lock waits (audit F1)', () => {
  let api: ApiHarness;
  let raw: PrismaClient;
  let sweeper: ReservationSweeper;
  const organizations: string[] = [];
  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  beforeAll(async () => {
    api = await startApi({
      INVENTORY_LOCK_TIMEOUT_MS: '10000',
      INVENTORY_RESERVATION_MAX_TTL_SECONDS: '120',
    });
    raw = runtimeClient();
    sweeper = new ReservationSweeper(
      api.app.get(ReservationRepository),
      api.app.get(ReservationExpiry),
      {
        intervalMs: 60_000,
        batchSize: 100,
      },
    );
  });
  afterAll(async () => {
    await sweeper.stop();
    await cleanup(organizations);
    await raw.$disconnect();
    await api.close();
  });

  async function deadline(seconds: number): Promise<string> {
    const [row] = await raw.$queryRaw<{ at: Date }[]>`
      SELECT date_trunc('milliseconds', clock_timestamp() + ${seconds} * interval '1 second') AS at`;
    return row!.at.toISOString();
  }

  async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
    const end = performance.now() + 15_000;
    while (performance.now() < end) {
      const found = await read();
      if (found !== undefined) return found;
    }
    throw new Error('Database condition did not become true within 15 seconds');
  }

  async function past(expiresAt: string): Promise<void> {
    await until(async () => {
      const [row] = await raw.$queryRaw<{ due: boolean }[]>`
        SELECT clock_timestamp() >= ${expiresAt}::timestamptz AS due`;
      return row?.due ? true : undefined;
    });
  }

  async function hold(
    organizationId: string,
    id: string,
    table: 'stock_item' | 'stock_reservation',
  ) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: (pid: number) => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<number>((resolve, reject) => {
      acquired = resolve;
      failed = reject;
    });
    const done = raw
      .$transaction(
        async (tx) => {
          const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>(
            `SELECT pg_backend_pid() AS pid FROM "${table}" WHERE "organization_id" = $1 AND "id" = $2 FOR UPDATE`,
            organizationId,
            id,
          );
          if (!row) throw new Error('Missing lock fixture');
          acquired(row.pid);
          await gate;
        },
        { timeout: 25_000 },
      )
      .catch((error: unknown) => {
        failed(error);
        throw error;
      });
    const pid = await ready;
    return {
      pid,
      release: async () => {
        release();
        await done;
      },
    };
  }

  async function waitingOn(pid: number, expiresAt?: string): Promise<void> {
    const started = await until(async () => {
      const rows = await raw.$queryRaw<{ started: Date }[]>`
        SELECT xact_start AS started FROM pg_stat_activity
         WHERE ${pid}::integer = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`;
      return rows[0]?.started;
    });
    if (expiresAt) expect(started.getTime()).toBeLessThan(new Date(expiresAt).getTime());
  }

  it.each(['issue', 'release'] as const)(
    '%s refuses after the stock lock crosses the deadline; sweep persists expiry once',
    async (kind) => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 5);
      const owner = client(api, orgAdmin(a));
      const expiresAt = await deadline(3);
      const reserved = await owner.reserve([{ stockItemId, quantity: 2 }], { expiresAt });
      expect(reserved.status).toBe(201);
      const id = reserved.body.reservations[0].id as string;
      const lock = await hold(a, stockItemId, 'stock_item');
      const k = key();
      const pending = owner[kind](id, k).then((answer) => answer);
      try {
        await waitingOn(lock.pid, expiresAt);
        await past(expiresAt);
      } finally {
        await lock.release();
      }
      const refused = await pending;
      expect(refused.status).toBe(409);
      expect(refused.body.details).toEqual([
        expect.objectContaining({ code: 'RESERVATION_NOT_ACTIVE' }),
      ]);
      expect((await owner.get(`/v1/stock/reservations/${id}`)).body.status).toBe('ACTIVE');
      expect((await owner.stockItem(stockItemId)).body).toMatchObject({
        onHandQuantity: 5,
        reservedQuantity: 2,
      });
      expect(
        await raw.stockMovement.count({
          where: { organizationId: a, type: { in: ['ISSUE', 'RELEASE'] } },
        }),
      ).toBe(0);
      expect(
        await raw.outboxMessage.count({
          where: { organizationId: a, eventName: 'STOCK_RELEASED' },
        }),
      ).toBe(0);
      // Failure releases the claim: retry refuses for expiry, rather than replaying/claim conflict.
      expect((await owner[kind](id, k)).body.details).toEqual(refused.body.details);
      await sweeper.runOnce();
      await sweeper.runOnce();
      const ended = await raw.stockReservation.findFirstOrThrow({
        where: { organizationId: a, id },
      });
      expect(ended).toMatchObject({ status: 'EXPIRED', endedBy: 'inventory-service' });
      expect((await owner.stockItem(stockItemId)).body).toMatchObject({
        onHandQuantity: 5,
        reservedQuantity: 0,
      });
      const movements = await raw.stockMovement.findMany({
        where: { organizationId: a, reservationId: id, type: 'RELEASE' },
      });
      const events = await raw.outboxMessage.findMany({
        where: { organizationId: a, eventName: 'STOCK_RELEASED' },
      });
      expect(movements).toHaveLength(1);
      expect(events).toHaveLength(1);
      expect(movements[0]?.createdAt).toEqual(ended.endedAt);
      expect(events[0]?.payload).toMatchObject({
        occurredAt: ended.endedAt!.toISOString(),
        actor: { type: 'SERVICE', id: 'inventory-service' },
        payload: { reason: 'EXPIRED', releasedAt: ended.endedAt!.toISOString() },
      });
      await expectReconciled(raw, [a]);
    },
  );

  it('issue decides before a generous deadline and replays without a second movement', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const owner = client(api, orgAdmin(a));
    const expiresAt = await deadline(60);
    const id = (await owner.reserve([{ stockItemId, quantity: 2 }], { expiresAt })).body
      .reservations[0].id as string;
    const lock = await hold(a, stockItemId, 'stock_item');
    const k = key();
    const pending = owner.issue(id, k).then((answer) => answer);
    try {
      await waitingOn(lock.pid, expiresAt);
    } finally {
      await lock.release();
    }
    const issued = await pending;
    expect(issued.status).toBe(200);
    const ended = await raw.stockReservation.findFirstOrThrow({ where: { organizationId: a, id } });
    expect(ended.status).toBe('CONSUMED');
    expect(ended.endedAt!.getTime()).toBeLessThan(new Date(expiresAt).getTime());
    expect((await owner.stockItem(stockItemId)).body).toMatchObject({
      onHandQuantity: 3,
      reservedQuantity: 0,
    });
    expect((await owner.issue(id, k)).body).toEqual(issued.body);
    expect(await raw.stockMovement.count({ where: { organizationId: a, type: 'ISSUE' } })).toBe(1);
    const [event] = await raw.outboxMessage.findMany({
      where: { organizationId: a, eventName: 'STOCK_ISSUED' },
    });
    expect(event?.payload).toMatchObject({
      occurredAt: ended.endedAt!.toISOString(),
      payload: { issuedAt: ended.endedAt!.toISOString() },
    });
    await expectReconciled(raw, [a]);
  });

  it('issue also samples after the reservation row lock', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const owner = client(api, orgAdmin(a));
    const expiresAt = await deadline(3);
    const id = (await owner.reserve([{ stockItemId, quantity: 2 }], { expiresAt })).body
      .reservations[0].id as string;
    const lock = await hold(a, id, 'stock_reservation');
    const pending = owner.issue(id).then((answer) => answer);
    try {
      await waitingOn(lock.pid, expiresAt);
      await past(expiresAt);
    } finally {
      await lock.release();
    }
    expect((await pending).status).toBe(409);
    expect((await owner.stockItem(stockItemId)).body.onHandQuantity).toBe(5);
    await sweeper.runOnce();
    expect((await owner.get(`/v1/stock/reservations/${id}`)).body.status).toBe('EXPIRED');
    await expectReconciled(raw, [a]);
  });

  it.each([true, false])(
    'create waits on the SECOND item and validates expiresAt after the final lock (expiry=%s)',
    async (expiring) => {
      const a = org();
      const first = await seedStock(api, a, 5);
      const second = await seedStock(api, a, 5, { warehouseId: first.warehouseId });
      const ids = [first.stockItemId, second.stockItemId].sort();
      const owner = client(api, orgAdmin(a));
      const expiresAt = await deadline(3);
      const lock = await hold(a, ids[1]!, 'stock_item');
      const pending = owner
        .reserve(
          ids.map((stockItemId) => ({ stockItemId, quantity: 1 })),
          expiring ? { expiresAt } : {},
        )
        .then((answer) => answer);
      try {
        await waitingOn(lock.pid, expiresAt);
        await past(expiresAt);
      } finally {
        await lock.release();
      }
      const answer = await pending;
      expect(answer.status).toBe(expiring ? 422 : 201);
      if (expiring) {
        expect(answer.body.details).toEqual([
          expect.objectContaining({ code: 'EXPIRY_OUT_OF_RANGE' }),
        ]);
        expect(await raw.stockReservation.count({ where: { organizationId: a } })).toBe(0);
        expect(
          await raw.stockMovement.count({ where: { organizationId: a, type: 'RESERVE' } }),
        ).toBe(0);
      } else {
        expect(answer.body.reservations).toHaveLength(2);
        expect(
          answer.body.reservations.every((r: { expiresAt: string | null }) => r.expiresAt === null),
        ).toBe(true);
        const rows = await raw.stockReservation.findMany({ where: { organizationId: a } });
        const times = new Set(rows.map((row) => row.createdAt.toISOString()));
        expect(times.size).toBe(1);
        const [at] = [...times];
        const events = await raw.outboxMessage.findMany({
          where: { organizationId: a, eventName: 'STOCK_RESERVED' },
        });
        expect(events).toHaveLength(2);
        for (const event of events)
          expect(event.payload).toMatchObject({ occurredAt: at, payload: { reservedAt: at } });
      }
      await expectReconciled(raw, [a]);
    },
  );
  it('sweeper samples after reservation candidate locks, including a deadline crossed in the wait', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const owner = client(api, orgAdmin(a));
    const expiresAt = await deadline(3);
    const id = (await owner.reserve([{ stockItemId, quantity: 2 }], { expiresAt })).body
      .reservations[0].id as string;
    const lock = await hold(a, id, 'stock_reservation');
    const pending = api.app.get(ReservationExpiry).expireBatch(a, stockItemId, key(), 'sweeper');
    try {
      await waitingOn(lock.pid, expiresAt);
      await past(expiresAt);
    } finally {
      await lock.release();
    }
    expect(await pending).toMatchObject({ expired: 1, backlog: false });
    expect((await owner.get(`/v1/stock/reservations/${id}`)).body.status).toBe('EXPIRED');
    await expectReconciled(raw, [a]);
  });

  it.each([0, 120, 121])(
    'create validates the exact decision instant and max TTL (offset=%s seconds)',
    async (seconds) => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 5);
      const owner = client(api, orgAdmin(a));
      // Boundary proof: both the injected single reading and caller deadline originate in SQL.
      // Lock-wait proofs above use the unmodified advancing database clock.
      const [row] = await raw.$queryRaw<{ at: Date; expires: Date }[]>`
      SELECT at, at + ${seconds} * interval '1 second' AS expires
      FROM (SELECT date_trunc('milliseconds', clock_timestamp()) AS at) t`;
      const sample = jest.mocked(clock.databaseClock).mockClear().mockResolvedValueOnce(row!.at);
      try {
        const answer = await owner.reserve([{ stockItemId, quantity: 1 }], {
          expiresAt: row!.expires.toISOString(),
        });
        expect(answer.status).toBe(seconds === 120 ? 201 : 422);
        expect(sample).toHaveBeenCalledTimes(1);
        if (seconds !== 120)
          expect(answer.body.details).toEqual([
            expect.objectContaining({ code: 'EXPIRY_OUT_OF_RANGE' }),
          ]);
      } finally {
        sample
          .mockReset()
          .mockImplementation(
            jest.requireActual<typeof clock>('../src/shared/clock').databaseClock,
          );
      }
      await expectReconciled(raw, [a]);
    },
  );

  it('command and sweep agree that equality is due', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const owner = client(api, orgAdmin(a));
    const expiresAt = await deadline(60);
    const id = (await owner.reserve([{ stockItemId, quantity: 2 }], { expiresAt })).body
      .reservations[0].id as string;
    // The fixture deadline was generated by PostgreSQL; make the decision exactly equal to it.
    const at = new Date(expiresAt);
    const sample = jest.mocked(clock.databaseClock).mockClear().mockResolvedValue(at);
    try {
      expect((await owner.issue(id)).status).toBe(409);
      expect(
        await api.app.get(ReservationExpiry).expireBatch(a, stockItemId, key(), 'sweeper'),
      ).toMatchObject({ expired: 1 });
      expect((await owner.get(`/v1/stock/reservations/${id}`)).body.status).toBe('EXPIRED');
    } finally {
      sample
        .mockReset()
        .mockImplementation(jest.requireActual<typeof clock>('../src/shared/clock').databaseClock);
    }
    await expectReconciled(raw, [a]);
  });
  it.each(['receive', 'adjust'] as const)(
    '%s expires reservations at its post-lock instant and stamps expiry and command alike',
    async (kind) => {
      const a = org();
      const { stockItemId, warehouseId, productId } = await seedStock(api, a, 5);
      const owner = client(api, orgAdmin(a));
      const expiresAt = await deadline(3);
      expect((await owner.reserve([{ stockItemId, quantity: 2 }], { expiresAt })).status).toBe(201);
      const lock = await hold(a, stockItemId, 'stock_item');
      const pending = (
        kind === 'receive'
          ? owner.receive(warehouseId, 1, productId)
          : owner.adjust(stockItemId, -4)
      ).then((answer) => answer);
      try {
        await waitingOn(lock.pid, expiresAt);
        await past(expiresAt);
      } finally {
        await lock.release();
      }
      expect((await pending).status).toBe(201);
      expect((await owner.stockItem(stockItemId)).body).toMatchObject({
        onHandQuantity: kind === 'receive' ? 6 : 1,
        reservedQuantity: 0,
      });
      const [expired] = await raw.stockReservation.findMany({
        where: { organizationId: a, stockItemId },
      });
      expect(expired?.status).toBe('EXPIRED');
      const decision = expired!.endedAt!;
      const movements = await raw.stockMovement.findMany({
        where: { organizationId: a, createdAt: decision },
      });
      expect(movements).toHaveLength(2);
      const eventName = kind === 'receive' ? 'STOCK_RECEIVED' : 'STOCK_ADJUSTED';
      const events = await raw.outboxMessage.findMany({
        where: { organizationId: a, eventName: { in: ['STOCK_RELEASED', eventName] } },
      });
      const atDecision = events.filter(
        (event) => (event.payload as { occurredAt: string }).occurredAt === decision.toISOString(),
      );
      expect(atDecision).toHaveLength(2);
      await expectReconciled(raw, [a]);
    },
  );
});
