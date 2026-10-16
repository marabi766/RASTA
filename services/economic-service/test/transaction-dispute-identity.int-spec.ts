import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { admin, apiTenant, internalToken, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * A resolution decides one dispute, named by its identity (Codex on #318
 * round 2, N1; docs/23 D-053).
 *
 * The order saga's operator decided dispute A. Before the saga mirrored that
 * decision, A had been resolved here and B raised, on other grounds; the
 * resolution, which named nothing, cleared B and settlement went ahead on a
 * decision nobody had taken about it. Every dispute now has an identity of
 * its own (`disputeId`, assigned by the database), and a resolution that
 * names one is applied only while the transaction still holds it — checked
 * under the transaction's row lock.
 *
 * Everything goes through the saga's own token and keys: an order's
 * transaction is disputed and resolved only through the order (the product
 * owner's answer to Q-138), and that path is the one these cases are about.
 */
describe('a dispute resolution names the dispute it decides', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('DSPID-PAYER');
  const payee = apiTenant('DSPID-PAYEE');
  const asSaga = () => internalToken('marketplace-service', { organizationId: payer });

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;

    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(payer)}`)
      .expect(200);
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(payer)}`)
      .set('idempotency-key', id('dspid-fund'))
      .send({ amountMinor: '30000000' })
      .expect(201);
    await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(payee)}`)
      .expect(200);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee]);
    await harness.close();
  });

  /** The order's obligation, held, as the saga's first economic step makes it. */
  async function holdFor(order: string): Promise<string> {
    const created = await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', await asSaga())
      .set('idempotency-key', `order:${order}:hold`)
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '500000',
        currency: 'IRR',
        sourceType: 'ORDER',
        sourceReference: order,
        holdFunds: true,
      })
      .expect(201);
    return created.body.id;
  }

  const dispute = async (order: string, transactionId: string, key: string, reason: string) =>
    request(http)
      .post(`/v1/transactions/${transactionId}/dispute`)
      .set('x-internal-token', await asSaga())
      .set('idempotency-key', `order:${order}:dispute:${key}`)
      .send({ reason });

  const resolveDispute = async (
    order: string,
    transactionId: string,
    key: string,
    body: { resolution: string; disputeId?: string },
  ) =>
    request(http)
      .post(`/v1/transactions/${transactionId}/resolve-dispute`)
      .set('x-internal-token', await asSaga())
      .set('idempotency-key', `order:${order}:resolve-dispute:${key}`)
      .send(body);

  const read = async (transactionId: string) =>
    (
      await request(http)
        .get(`/v1/transactions/${transactionId}`)
        .set('x-internal-token', await asSaga())
        .expect(200)
    ).body;

  /** Disputed (A), resolved by a decision not about to be mirrored, disputed again (B). */
  async function replaced(order: string, transactionId: string) {
    expect(
      (await dispute(order, transactionId, 'DSP_A', 'two pallets short on arrival')).status,
    ).toBe(200);
    const a = (await read(transactionId)).disputeId as string;
    // Resolved by someone else's decision, under a key of its own.
    expect(
      (
        await resolveDispute(order, transactionId, 'ELSEWHERE', {
          resolution: 'counted again: complete',
        })
      ).status,
    ).toBe(200);
    expect(
      (await dispute(order, transactionId, 'DSP_B', 'the invoice names another supplier')).status,
    ).toBe(200);
    const b = (await read(transactionId)).disputeId as string;
    return { a, b };
  }

  const resolutionsOf = async (transactionId: string) => {
    const changes = await runUnscoped('the suite reads the changes announced', () =>
      harness.prisma.client.outboxMessage.findMany({
        where: { aggregateId: transactionId, eventName: 'TRANSACTION_STATUS_CHANGED' },
        select: { payload: true },
      }),
    );
    return changes.filter((change) =>
      JSON.stringify(change.payload).includes('"action":"RESOLVE_DISPUTE"'),
    ).length;
  };

  it('every dispute has an identity of its own, kept through its resolution', async () => {
    const order = id('ORD');
    const transactionId = await holdFor(order);
    expect((await read(transactionId)).disputeId).toBeNull();

    expect(
      (await dispute(order, transactionId, 'DSP_1', 'two pallets short on arrival')).status,
    ).toBe(200);
    const first = await read(transactionId);
    expect(first).toMatchObject({ status: 'DISPUTED', disputeId: expect.stringMatching(/^TXD_/) });

    const resolved = await resolveDispute(order, transactionId, 'DSP_1', {
      resolution: 'the supplier showed a signed delivery note',
      disputeId: first.disputeId,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      status: 'PENDING_SETTLEMENT',
      disputeId: first.disputeId,
    });

    expect(
      (await dispute(order, transactionId, 'DSP_2', 'the note is for another order')).status,
    ).toBe(200);
    const second = await read(transactionId);
    expect(second.disputeId).toMatch(/^TXD_/);
    expect(second.disputeId).not.toBe(first.disputeId);
  });

  it('a decision about a dispute replaced since is refused, and the new dispute stands', async () => {
    const order = id('ORD');
    const transactionId = await holdFor(order);
    const { a, b } = await replaced(order, transactionId);
    expect(b).not.toBe(a);

    const refused = await resolveDispute(order, transactionId, 'DSP_A', {
      resolution: 'the supplier showed a signed delivery note',
      disputeId: a,
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      message: 'The transaction no longer holds the dispute this decision is about',
    });
    // Neither identity is in the envelope.
    expect(JSON.stringify(refused.body)).not.toContain(a);
    expect(JSON.stringify(refused.body)).not.toContain(b);

    expect(await read(transactionId)).toMatchObject({
      status: 'DISPUTED',
      disputeId: b,
      disputeReason: 'the invoice names another supplier',
    });
    // Only the resolution made elsewhere was announced.
    expect(await resolutionsOf(transactionId)).toBe(1);

    // B's own decision, named, resolves it.
    const decided = await resolveDispute(order, transactionId, 'DSP_B', {
      resolution: 'the invoice was reissued to this supplier',
      disputeId: b,
    });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ status: 'PENDING_SETTLEMENT', disputeId: b });
  });

  it('a name the transaction never held is refused', async () => {
    const order = id('ORD');
    const transactionId = await holdFor(order);
    expect(
      (await dispute(order, transactionId, 'DSP_1', 'two pallets short on arrival')).status,
    ).toBe(200);

    const refused = await resolveDispute(order, transactionId, 'DSP_1', {
      resolution: 'the supplier showed a signed delivery note',
      disputeId: 'TXD_00000000-0000-0000-0000-000000000000',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await read(transactionId)).status).toBe('DISPUTED');
  });

  it('a resolution that names nothing resolves the dispute held, as before', async () => {
    const order = id('ORD');
    const transactionId = await holdFor(order);
    const { b } = await replaced(order, transactionId);

    const resolved = await resolveDispute(order, transactionId, 'UNNAMED', {
      resolution: 'the invoice was reissued to this supplier',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ status: 'PENDING_SETTLEMENT', disputeId: b });
  });

  it('is checked under the row lock: a dispute replaced while the resolution waits for it is refused', async () => {
    // A separate read before the lock would see A, pass, then wait — and
    // resolve B once the lock was released.
    const order = id('ORD');
    const transactionId = await holdFor(order);
    expect(
      (await dispute(order, transactionId, 'DSP_A', 'two pallets short on arrival')).status,
    ).toBe(200);
    const a = (await read(transactionId)).disputeId as string;

    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });

    // Another writer holds the row: it resolves A and raises B, in one
    // transaction, while the resolution of A waits.
    const writer = harness.prisma.transaction(async (tx) => {
      await runUnscoped(
        'the suite holds the row as a concurrent writer would',
        () => tx.$queryRaw`SELECT id FROM "transaction" WHERE id = ${transactionId} FOR UPDATE`,
      );
      locked();
      await gate;
      await runUnscoped(
        'the concurrent writer resolves A',
        () =>
          tx.$executeRaw`UPDATE "transaction"
                          SET status = 'PENDING_SETTLEMENT', dispute_resolved_at = now()
                        WHERE id = ${transactionId}`,
      );
      await runUnscoped(
        'the concurrent writer raises B',
        () =>
          tx.$executeRaw`UPDATE "transaction"
                          SET status = 'DISPUTED', disputed_at = now(),
                              dispute_reason = 'the invoice names another supplier'
                        WHERE id = ${transactionId}`,
      );
    });
    await holding;

    const decision = resolveDispute(order, transactionId, 'DSP_A', {
      resolution: 'the supplier showed a signed delivery note',
      disputeId: a,
    });
    await eventually(async () => (await rowLockWaiters()) > 0, 'the resolution to wait on the row');
    release();
    await writer;

    const refused = await decision;
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('INVALID_STATE_TRANSITION');
    const now = await read(transactionId);
    expect(now).toMatchObject({
      status: 'DISPUTED',
      disputeReason: 'the invoice names another supplier',
    });
    expect(now.disputeId).toMatch(/^TXD_/);
    expect(now.disputeId).not.toBe(a);
  });

  it('the identity is the database’s: a write can neither set nor keep one', async () => {
    const order = id('ORD');
    const transactionId = await holdFor(order);
    const identity = async () =>
      (
        await runUnscoped(
          'the suite reads the identity',
          () =>
            harness.prisma.client.$queryRaw<{ dispute_id: string | null }[]>`
            SELECT dispute_id FROM "transaction" WHERE id = ${transactionId}`,
        )
      )[0]!.dispute_id;

    // Not disputed: nothing to name, whatever is written.
    await runUnscoped(
      'the suite forges an identity',
      () =>
        harness.prisma.client.$executeRaw`UPDATE "transaction"
                                           SET dispute_id = 'TXD_FORGED'
                                         WHERE id = ${transactionId}`,
    );
    expect(await identity()).toBeNull();

    // Into DISPUTED with a forged one: a new identity instead.
    await runUnscoped(
      'the suite disputes with a forged identity',
      () =>
        harness.prisma.client.$executeRaw`UPDATE "transaction"
                                           SET status = 'DISPUTED', disputed_at = now(),
                                               dispute_reason = 'two pallets short on arrival',
                                               dispute_id = 'TXD_FORGED'
                                         WHERE id = ${transactionId}`,
    );
    const assigned = await identity();
    expect(assigned).toMatch(/^TXD_/);
    expect(assigned).not.toBe('TXD_FORGED');

    // While DISPUTED, and out of it: kept.
    await runUnscoped(
      'the suite rewrites the identity',
      () =>
        harness.prisma.client.$executeRaw`UPDATE "transaction"
                                           SET dispute_id = 'TXD_FORGED'
                                         WHERE id = ${transactionId}`,
    );
    expect(await identity()).toBe(assigned);
    await runUnscoped(
      'the suite resolves it',
      () =>
        harness.prisma.client.$executeRaw`UPDATE "transaction"
                                           SET status = 'PENDING_SETTLEMENT', dispute_id = NULL
                                         WHERE id = ${transactionId}`,
    );
    expect(await identity()).toBe(assigned);
  });

  /**
   * Sessions waiting for a lock in the transaction lock's read right now.
   * Matched on its first columns: `pg_stat_activity` keeps 1 KiB of a query,
   * and that one's `FOR UPDATE` is further on.
   */
  const rowLockWaiters = async () => {
    const [row] = await runUnscoped(
      'the suite reads lock waits',
      () =>
        harness.prisma.client.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock'
           AND query LIKE '%AS "counterpartyOrganizationId"%'`,
    );
    return row?.n ?? 0;
  };

  async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${what}`);
  }
});
