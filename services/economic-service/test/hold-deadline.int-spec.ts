import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped, tryGetContext } from '@rasta/nest-common';
import { WalletService } from '../src/wallet/wallet.service';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * The hold's deadline at the receiving boundary (D-132; review of #812, F1).
 *
 * A saga gave a hold up and closed its order; a request of it, stalled before this
 * service, arrives afterwards with the buyer's wallet funded. Retention starts only
 * at the claim, so no retention fences it. The deadline the saga fixed at its first
 * send does: by this service's clock, in the claim's transaction and again in the
 * hold's, for good.
 */
describe('a hold past the deadline its caller fixed (HTTP, real database)', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('DEADLINE-PAYER');
  const payee = apiTenant('DEADLINE-PAYEE');
  const asPayer = () => `Bearer ${admin(payer)}`;
  const ENDPOINT = 'POST /v1/transactions';
  const PAST = '2020-01-01T00:00:00.000Z';
  const LATER = '2999-01-01T00:00:00.000Z';

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    const w = await wallet();
    await request(http)
      .post(`/v1/wallets/${w.id}/top-up`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('deadline-topup'))
      .send({ amountMinor: '500000' })
      .expect((response) => expect(response.status).toBeLessThan(300));
    await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(payee)}`)
      .expect(200);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee]);
    await harness.close();
  });

  async function wallet() {
    return (await request(http).get('/v1/wallets/me').set('authorization', asPayer()).expect(200))
      .body as { id: string; availableBalanceMinor: string; pendingBalanceMinor: string };
  }

  const hold = (
    key: string,
    holdNotAfter: string | undefined,
    sourceReference: string,
    token = asPayer(),
  ) =>
    request(http)
      .post('/v1/transactions')
      .set('authorization', token)
      .set('idempotency-key', key)
      .send({
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '7000',
        currency: 'IRR',
        holdFunds: true,
        sourceType: 'FREIGHT',
        sourceReference,
        ...(holdNotAfter === undefined ? {} : { holdNotAfter }),
      });

  const record = (key: string) =>
    runUnscoped('the suite reads the idempotency record', () =>
      harness.prisma.client.idempotencyKey.findFirst({
        where: { organizationId: payer, endpoint: ENDPOINT, key },
      }),
    );
  const obligations = (sourceReference: string) =>
    runUnscoped('the suite counts what the request recorded', () =>
      harness.prisma.client.transaction.count({ where: { sourceReference } }),
    );

  /** Refused, with nothing recorded or held, and the balances as they were. */
  async function expectNothingHeld(sourceReference: string, before: { available: string }) {
    expect(await obligations(sourceReference)).toBe(0);
    expect((await wallet()).availableBalanceMinor).toBe(before.available);
  }
  const refusal = (response: request.Response) =>
    expect({ status: response.status, code: (response.body as { code?: string }).code }).toEqual({
      status: 422,
      code: 'HOLD_DEADLINE_PASSED',
    });

  it('the stalled request of the review: refused at the claim, nothing recorded or held', async () => {
    const key = id('deadline-past');
    const reference = id('REF');
    const before = { available: (await wallet()).availableBalanceMinor };

    refusal(await hold(key, PAST, reference));

    await expectNothingHeld(reference, before);
    expect(await record(key)).toMatchObject({
      state: 'COMPLETED',
      responseStatus: 422,
      responseBody: { refusal: 'HOLD_DEADLINE_PASSED' },
    });
  });

  it('the same request again: the same answer, whichever retry hears it', async () => {
    const key = id('deadline-again');
    const reference = id('REF');
    const before = { available: (await wallet()).availableBalanceMinor };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      refusal(await hold(key, PAST, reference));
    }
    await expectNothingHeld(reference, before);
  });

  it('concurrent, both orders of the claim: every one refused, nothing held', async () => {
    const key = id('deadline-race');
    const reference = id('REF');
    const before = { available: (await wallet()).availableBalanceMinor };
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => hold(key, PAST, reference).then((r) => r)),
    );
    for (const answer of answers) refusal(answer);
    await expectNothingHeld(reference, before);
  });

  it.each([
    [
      'purged',
      (key: string) =>
        runUnscoped('the suite purges the record', () =>
          harness.prisma.client.idempotencyKey.deleteMany({
            where: { organizationId: payer, endpoint: ENDPOINT, key },
          }),
        ),
    ],
    [
      'expired',
      (key: string) =>
        runUnscoped('the suite expires the record', () =>
          harness.prisma.client.$executeRawUnsafe(
            `UPDATE idempotency_key
                SET created_at = now() - interval '48 hours',
                    expires_at = now() - interval '24 hours'
              WHERE organization_id = $1 AND endpoint = $2 AND key = $3`,
            payer,
            ENDPOINT,
            key,
          ),
        ),
    ],
  ])('its record %s, whatever the retention: refused again', async (_name, lapse) => {
    const key = id('deadline-lapse');
    const reference = id('REF');
    const before = { available: (await wallet()).availableBalanceMinor };
    refusal(await hold(key, PAST, reference));
    await lapse(key);
    refusal(await hold(key, PAST, reference));
    await expectNothingHeld(reference, before);
  });

  it('claimed in time, its work stalled past it: refused in the hold’s transaction, and the hold rolled back', async () => {
    const key = id('deadline-stall');
    const reference = id('REF');
    const before = { available: (await wallet()).availableBalanceMinor };
    const deadline = new Date(Date.now() + 1_500).toISOString();
    const place = WalletService.prototype.placeHold;
    let placed = 0;
    jest.spyOn(WalletService.prototype, 'placeHold').mockImplementation(async function (
      this: WalletService,
      ...args: Parameters<WalletService['placeHold']>
    ) {
      const result = await place.apply(this, args);
      if (tryGetContext()?.organizationId === payer) {
        placed += 1;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      return result;
    });

    refusal(await hold(key, deadline, reference));
    jest.restoreAllMocks();

    expect(placed).toBe(1);
    await expectNothingHeld(reference, before);
    expect(await record(key)).toMatchObject({
      state: 'COMPLETED',
      responseStatus: 422,
      responseBody: { refusal: 'HOLD_DEADLINE_PASSED' },
    });
    // Recorded, so that the next attempt under the key says the same.
    refusal(await hold(key, deadline, reference));
  });

  it('before it: held as ever; past it, the stored answer is replayed and not refused', async () => {
    const key = id('deadline-intime');
    const reference = id('REF');
    const deadline = new Date(Date.now() + 1_000).toISOString();

    const first = await hold(key, deadline, reference).expect(201);
    expect((first.body as { status: string }).status).toBe('HELD');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const again = await hold(key, deadline, reference).expect(201);

    expect((again.body as { id: string }).id).toBe((first.body as { id: string }).id);
    expect(await obligations(reference)).toBe(1);
  });

  it('a caller with no deadline holds as ever', async () => {
    const created = await hold(id('deadline-none'), undefined, id('REF')).expect(201);
    expect((created.body as { status: string }).status).toBe('HELD');
  });

  it('one key never answers two deadlines, and another spelling of one instant is the same request', async () => {
    const key = id('deadline-two');
    const reference = id('REF');
    const spelt = LATER.replace('.000Z', 'Z');
    const first = await hold(key, LATER, reference).expect(201);
    const same = await hold(key, spelt, reference).expect(201);
    expect((same.body as { id: string }).id).toBe((first.body as { id: string }).id);
    const other = await hold(key, '2998-01-01T00:00:00.000Z', reference).expect(409);
    expect((other.body as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('another actor under a refused key learns nothing of it', async () => {
    const key = id('deadline-actor');
    const reference = id('REF');
    refusal(await hold(key, PAST, reference));
    const other = `Bearer ${admin(payer, ['UNION_ADMIN'], 'other-person')}`;
    const answer = await hold(key, PAST, reference, other).expect(409);
    expect((answer.body as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it.each([
    ['not an instant', { holdNotAfter: 'tomorrow', holdFunds: true }],
    ['with no zone', { holdNotAfter: '2026-11-07T00:00:00', holdFunds: true }],
    ['on a request that holds nothing', { holdNotAfter: LATER, holdFunds: false }],
  ])('%s: 400, nothing claimed', async (_name, fields) => {
    const key = id('deadline-bad');
    const reference = id('REF');
    await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', key)
      .send({
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '7000',
        currency: 'IRR',
        sourceType: 'FREIGHT',
        sourceReference: reference,
        ...fields,
      })
      .expect(400);
    expect(await record(key)).toBeNull();
  });
});
