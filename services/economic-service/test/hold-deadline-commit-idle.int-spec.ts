import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped, tryGetContext } from '@rasta/nest-common';
import { IdempotencyStore } from '../src/shared/idempotency';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

// The limit is 30 s in service; the suite is not going to wait that long.
jest.mock('../src/config/operation-budgets', () => ({
  ...jest.requireActual('../src/config/operation-budgets'),
  FENCE_COMMIT_IDLE_MS: 300,
}));

/**
 * What the last check of a hold's deadline (D-132) cannot see: a process frozen after
 * it and before its COMMIT, then resuming with the deadline long gone. PostgreSQL has
 * ended that transaction by then, so nothing commits late.
 */
describe('a hold frozen between its last deadline check and its COMMIT', () => {
  let harness: ApiHarness;
  let http: Server;
  const payer = apiTenant('IDLE-PAYER');
  const payee = apiTenant('IDLE-PAYEE');
  const asPayer = () => `Bearer ${admin(payer)}`;

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', asPayer())
      .expect(200);
    await request(http)
      .post(`/v1/wallets/${(wallet.body as { id: string }).id}/top-up`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('idle-topup'))
      .send({ amountMinor: '500000' })
      .expect((response) => expect(response.status).toBeLessThan(300));
    await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(payee)}`)
      .expect(200);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee]);
    await harness.close();
  });

  it('commits nothing: no obligation, and the key freed for a retry to be judged', async () => {
    const reference = id('REF');
    const key = id('idle-key');
    const proto = IdempotencyStore.prototype as unknown as {
      complete: (this: unknown, ...args: unknown[]) => Promise<void>;
    };
    const completeOf = proto.complete;
    let frozen = 0;
    proto.complete = async function (this: unknown, ...args: unknown[]) {
      await completeOf.apply(this, args);
      if (tryGetContext()?.organizationId === payer && frozen === 0) {
        frozen += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    };
    try {
      const answer = await request(http)
        .post('/v1/transactions')
        .set('authorization', asPayer())
        .set('idempotency-key', key)
        .send({
          transactionType: 'LOGISTICS',
          counterpartyOrganizationId: payee,
          grossAmountMinor: '7000',
          currency: 'IRR',
          holdFunds: true,
          sourceType: 'FREIGHT',
          sourceReference: reference,
          holdNotAfter: '2999-01-01T00:00:00.000Z',
        });
      expect(frozen).toBe(1);
      expect(answer.status).toBeGreaterThanOrEqual(500);
    } finally {
      proto.complete = completeOf;
    }
    const rows = await runUnscoped('the suite counts what the request recorded', () =>
      harness.prisma.client.transaction.count({ where: { sourceReference: reference } }),
    );
    expect(rows).toBe(0);
  });
});
