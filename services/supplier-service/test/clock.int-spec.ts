import { runUnscoped } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { QualificationService } from '../src/supplier/qualification.service';
import { SupplierService } from '../src/supplier/supplier.service';
import { SuspensionService } from '../src/supplier/suspension.service';
import {
  asOperator,
  asSupplier,
  cleanup,
  newOrganizationId,
  outboxFor,
  wire,
} from './helpers';

/**
 * D-5 — one fact must not carry two clocks.
 *
 * ## The defect this file was written to demonstrate
 *
 * Some timestamps in this service came from PostgreSQL and some from Node, and
 * the two were then compared to each other:
 *
 *   `qualification.submitted_at`  database, via `@default(now())`
 *   `qualification.decided_at`    application, via `new Date()`
 *   `ck_qualification_decided_after_submitted`  compares them
 *
 * The service and the database do not share a clock. In a container pair whose
 * host clocks have drifted — or simply where NTP has stepped one of them — the
 * application clock can read earlier than the database clock. When it does, a
 * perfectly legitimate approval of a qualification submitted moments earlier is
 * refused by the CHECK constraint, and the operator sees a 500 from a rule that
 * was never about them.
 *
 * The same split made every event disagree with the row it announces:
 * `SUPPLIER_REGISTERED.registeredAt` was a `new Date()` taken in the service
 * while `supplier.registered_at` was the database default, so the event and the
 * row described one registration with two different times. A consumer building
 * a timeline from events would place the supplier at an instant the owning
 * service does not agree with.
 *
 * ## How the demonstration is made deterministic
 *
 * Waiting for real clock skew is not a test. Instead the **application** clock
 * is frozen a few seconds behind the database clock with fake timers — only
 * `Date` is faked, so Prisma's timers, sockets and query engine are untouched —
 * and the real services are then driven against real PostgreSQL. That is
 * precisely the state a trailing container clock produces, reproduced exactly
 * and on demand.
 *
 * Before the fix, the first test here failed with PostgreSQL 23514,
 * `ck_qualification_decided_after_submitted`. After it, the
 * database supplies one authoritative instant per transaction and the
 * application clock is no longer consulted for any persisted fact — so the same
 * skew changes nothing.
 *
 * **No constraint was weakened to make these pass.** `decided_at >=
 * submitted_at` still holds, and still rejects a decision that genuinely
 * predates its submission — `constraints.int-spec.ts` proves that separately.
 */
describe('D-5 — the database is the only clock a persisted fact uses', () => {
  // One organization per test. `supplier.organization_id` is unique — one
  // profile per organization is the directory's whole point — so tests that
  // shared an organization would collide on the second registration.
  const organizations: string[] = [];
  const freshOrganization = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  let prisma: PrismaService;
  let suppliers: SupplierService;
  let qualifications: QualificationService;
  let suspensions: SuspensionService;

  beforeAll(async () => {
    const wiring = wire();
    prisma = wiring.prisma;
    suppliers = wiring.suppliers;
    qualifications = wiring.qualifications;
    suspensions = wiring.suspensions;
    await prisma.onModuleInit();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(async () => {
    jest.useRealTimers();
    await cleanup(prisma, organizations);
    await prisma.onModuleDestroy();
  });

  /**
   * Freezes only `Date`, leaving every timer and the query engine real.
   *
   * `doNotFake` is the important half: faking `setTimeout` here would hang
   * Prisma's connection pool rather than test anything.
   */
  const withApplicationClockAt = async <T>(instant: Date, fn: () => Promise<T>): Promise<T> => {
    jest.useFakeTimers({
      now: instant,
      doNotFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'nextTick',
        'queueMicrotask',
        'performance',
        'hrtime',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
      ],
    });
    try {
      return await fn();
    } finally {
      jest.useRealTimers();
    }
  };

  /** What PostgreSQL currently thinks the time is. */
  const databaseNow = async (): Promise<Date> => {
    const rows = await runUnscoped('reading the database clock for a test assertion', () =>
      prisma.client.$queryRawUnsafe<{ now: Date }[]>('SELECT now() AS now'),
    );
    return rows[0].now;
  };

  const register = async (org: string, displayName: string) =>
    asSupplier(org, () =>
      suppliers.register({
        displayName,
        capabilities: ['WORKSHOP_SERVICE'],
      } as never),
    );

  it('decides a fresh submission even when the application clock trails the database', async () => {
    const org = freshOrganization();
    const supplier = await register(org, 'کارگاه آزمون ساعت');
    const submitted = await asSupplier(org, () =>
      qualifications.submit(supplier.id, {
        capability: 'WORKSHOP_SERVICE',
        statement: 'clock probe',
        evidence: [],
      } as never),
    );

    // Five seconds behind PostgreSQL — a skew far smaller than what an
    // unsynchronised container pair drifts to, and more than enough to put
    // `decided_at` before `submitted_at` if the application clock is used.
    const behind = new Date((await databaseNow()).getTime() - 5_000);

    await withApplicationClockAt(behind, async () => {
      // Before the D-5 fix this threw:
      //   PostgresError 23514 — new row for relation "qualification" violates
      //   check constraint "ck_qualification_decided_after_submitted"
      await asOperator(() =>
        qualifications.decide(supplier.id, submitted.id, 'APPROVED', {
          note: 'approved under a trailing application clock',
        } as never),
      );
    });

    const row = await runUnscoped('reading back the decided row', () =>
      prisma.client.qualification.findUniqueOrThrow({ where: { id: submitted.id } }),
    );

    expect(row.state).toBe('APPROVED');
    expect(row.decidedAt).not.toBeNull();
    // The constraint's own property, restated as an assertion rather than
    // trusted to the database: the decision does not predate the submission.
    expect(row.decidedAt!.getTime()).toBeGreaterThanOrEqual(row.submittedAt.getTime());
    // And the decisive one: the stored instant is the database's, not the
    // frozen application clock's.
    expect(row.decidedAt!.getTime()).toBeGreaterThan(behind.getTime());
  });

  it('suspends and reinstates on the database clock, not the application one', async () => {
    const org = freshOrganization();
    const supplier = await register(org, 'کارگاه تعلیق');

    const behind = new Date((await databaseNow()).getTime() - 5_000);
    await withApplicationClockAt(behind, async () => {
      await asOperator(() =>
        suspensions.suspend(supplier.id, { reason: 'clock probe' } as never),
      );
      await asOperator(() =>
        suspensions.reinstate(supplier.id, { reason: 'clock probe lifted' } as never),
      );
    });

    const episode = await runUnscoped('reading back the suspension episode', () =>
      prisma.client.suspension.findFirstOrThrow({
        where: { supplierId: supplier.id },
        orderBy: { suspendedAt: 'desc' },
      }),
    );

    expect(episode.reinstatedAt).not.toBeNull();
    expect(episode.reinstatedAt!.getTime()).toBeGreaterThanOrEqual(episode.suspendedAt.getTime());
    expect(episode.suspendedAt.getTime()).toBeGreaterThan(behind.getTime());
  });

  it('gives the row and the event it announces exactly one instant', async () => {
    const org = freshOrganization();
    const supplier = await register(org, 'کارگاه رویداد');

    const row = await runUnscoped('reading back the registered supplier', () =>
      prisma.client.supplier.findUniqueOrThrow({ where: { id: supplier.id } }),
    );

    const events = await outboxFor(prisma, org);
    const registered = events.filter(
      (event) =>
        event.eventName === 'SUPPLIER_REGISTERED' &&
        (event.payload as { payload: { supplierId: string } }).payload.supplierId === supplier.id,
    );
    expect(registered).toHaveLength(1);

    const envelope = registered[0].payload as {
      occurredAt: string;
      payload: { registeredAt: string };
    };

    // One fact, one time. The event's own `occurredAt`, the `registeredAt` it
    // carries in its payload and the row's `registered_at` are the same instant
    // — not "close", the same. Any drift here is a consumer building a timeline
    // the owning service disagrees with.
    expect(envelope.payload.registeredAt).toBe(row.registeredAt.toISOString());
    expect(envelope.occurredAt).toBe(row.registeredAt.toISOString());
  });

  it('agrees between the decision row and the event that announces it', async () => {
    const org = freshOrganization();
    const supplier = await register(org, 'کارگاه تصمیم');
    const submitted = await asSupplier(org, () =>
      qualifications.submit(supplier.id, {
        capability: 'WORKSHOP_SERVICE',
        statement: 'decision agreement probe',
        evidence: [],
      } as never),
    );

    await asOperator(() =>
      qualifications.decide(supplier.id, submitted.id, 'REJECTED', {
        reason: 'not this time',
      } as never),
    );

    const row = await runUnscoped('reading back the decided row', () =>
      prisma.client.qualification.findUniqueOrThrow({ where: { id: submitted.id } }),
    );

    const events = await outboxFor(prisma, org);
    const rejected = events.filter(
      (event) =>
        event.eventName === 'SUPPLIER_REJECTED' &&
        (event.payload as { payload: { qualificationId: string } }).payload.qualificationId ===
          submitted.id,
    );
    expect(rejected).toHaveLength(1);

    const envelope = rejected[0].payload as {
      occurredAt: string;
      payload: { decidedAt: string };
    };

    expect(row.decidedAt).not.toBeNull();
    expect(envelope.payload.decidedAt).toBe(row.decidedAt!.toISOString());
    expect(envelope.occurredAt).toBe(row.decidedAt!.toISOString());
  });
});
