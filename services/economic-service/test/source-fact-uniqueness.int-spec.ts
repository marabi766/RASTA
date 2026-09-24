import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { asActor, cleanup, id, newPrisma, tenants, wire, type Wiring } from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * One obligation per business fact, per payer (`ux_transaction_source_fact`).
 *
 * `recordAuthorisedObligation` was check-then-insert with nothing underneath
 * it. Two `MAINTENANCE_APPROVED` events for one repair, processed at the same
 * moment under different event ids, could both miss the check and both
 * insert — two `PENDING_SETTLEMENT` obligations, both of which settle.
 *
 * The race is driven deterministically rather than hoped for: the first
 * writer inserts and then holds its commit open, and the second is observed
 * **waiting on that insert's lock** in `pg_stat_activity` before the first is
 * allowed to commit. So the assertion is about the losing path actually
 * taken, not about two calls that happened to run one after the other.
 */
describe('source fact uniqueness — concurrency, duplicate and tenant isolation', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();

  const fact = (reference: string) => ({
    organizationId: org.a,
    counterpartyOrganizationId: org.b,
    transactionType: 'MAINTENANCE_SERVICE' as const,
    grossAmountMinor: 480_000n,
    currency: 'IRR',
    occurredAt: new Date(),
    sourceType: 'MAINTENANCE_REQUEST',
    sourceReference: reference,
  });

  const rowsFor = (reference: string) =>
    runUnscoped('the suite counts rows for one fact across the whole table', () =>
      prisma.client.transaction.findMany({
        where: { sourceType: 'MAINTENANCE_REQUEST', sourceReference: reference },
        include: { legs: true },
      }),
    );

  /** Resolves once some session is blocked on a lock inside an INSERT into `transaction`. */
  async function untilAnInsertWaits(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [row] = await prisma.client.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting
          FROM pg_stat_activity
         WHERE wait_event_type = 'Lock'
           AND query ILIKE '%INSERT INTO%"transaction"%'`;
      if (row && row.waiting > 0n) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The second writer never blocked on the first insert');
  }

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  it('records one obligation when two approvals of one repair race', async () => {
    const reference = `MRQ_${ulid()}`;
    let releaseFirst!: () => void;
    const firstMayCommit = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstInserted!: () => void;
    const insertedByFirst = new Promise<void>((resolve) => (firstInserted = resolve));

    const first = asActor({ organizationId: org.a }, () =>
      prisma.transaction(async (tx) => {
        const result = await wiring.transactions.recordAuthorisedObligation(tx, fact(reference));
        firstInserted();
        await firstMayCommit;
        return result;
      }),
    );

    await insertedByFirst;
    const second = asActor({ organizationId: org.a }, () =>
      prisma.transaction((tx) =>
        wiring.transactions.recordAuthorisedObligation(tx, fact(reference)),
      ),
    );

    // The second writer missed the fast-path read (the first has not
    // committed) and is now blocked on the unique index behind it.
    await untilAnInsertWaits();
    releaseFirst();

    const [a, b] = await Promise.all([first, second]);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);

    const rows = await rowsFor(reference);
    expect(rows).toHaveLength(1);
    // The loser wrote no legs of its own either.
    expect(rows[0]!.legs).toHaveLength(2);
  });

  it('returns the existing obligation for a re-emitted approval', async () => {
    const reference = `MRQ_${ulid()}`;
    const record = () =>
      asActor({ organizationId: org.a }, () =>
        prisma.transaction((tx) =>
          wiring.transactions.recordAuthorisedObligation(tx, fact(reference)),
        ),
      );

    const original = await record();
    const again = await record();

    expect(again).toEqual({ id: original.id, created: false });
    expect(await rowsFor(reference)).toHaveLength(1);
  });

  describe('over HTTP', () => {
    let harness: ApiHarness;
    let http: Server;
    const payer = apiTenant('SRC-PAYER');
    const payee = apiTenant('SRC-PAYEE');
    const other = apiTenant('SRC-OTHER');

    const create = (organizationId: string, reference: string) =>
      request(http)
        .post('/v1/transactions')
        .set('authorization', `Bearer ${admin(organizationId)}`)
        .set('idempotency-key', id('src-create'))
        .send({
          transactionType: 'MAINTENANCE_SERVICE',
          counterpartyOrganizationId: payee,
          grossAmountMinor: '9000',
          currency: 'IRR',
          sourceType: 'MAINTENANCE_REQUEST',
          sourceReference: reference,
        });

    beforeAll(async () => {
      harness = await startApi();
      http = harness.app.getHttpServer() as Server;
    });

    afterAll(async () => {
      await cleanup(harness.prisma, [payer, payee, other]);
      await harness.close();
    });

    it('refuses a duplicate under a different Idempotency-Key with 409, not 500', async () => {
      const reference = `MRQ_${ulid()}`;
      await create(payer, reference).expect(201);

      const duplicate = await create(payer, reference).expect(409);
      expect(duplicate.body.code).toBe('CONFLICT');
      expect(await rowsFor(reference)).toHaveLength(1);
    });

    it('records one obligation when two different keys race for the same fact', async () => {
      const reference = `MRQ_${ulid()}`;
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => create(payer, reference)),
      );

      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
      expect(await rowsFor(reference)).toHaveLength(1);
    });

    it('does not let one tenant block another tenant’s fact — tenant isolation', async () => {
      // The key includes the payer. Were it platform-wide, an organization that
      // recorded another's request id first would stop that approval from ever
      // being recorded, and learn from the 409 that the id exists.
      const reference = `MRQ_${ulid()}`;
      await create(other, reference).expect(201);
      await create(payer, reference).expect(201);

      const rows = await rowsFor(reference);
      expect(rows.map((row) => row.organizationId).sort()).toEqual([other, payer].sort());
    });
  });
});
