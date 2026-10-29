import request from 'supertest';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import { expectNotDisclosed } from '@rasta/testing';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * What the service logs when it refuses a spend: the wallet and a reason,
 * never the figures (AGENTS.md S-09; economic audit F9).
 *
 * `RastaError.insufficientBalance` carried the requested and the available
 * amount in `internalContext`, and the exception filter logs that object at
 * debug — so with debug logging on, every refused spend wrote an
 * organization's balance into the log. Neither field is in the redaction list,
 * so nothing downstream removed them.
 *
 * Read through the **real** logger: the one `LOGGER` builds, at `debug`, with
 * its redaction and scrubbing, writing to a stream this suite reads — and
 * Nest's logger installed over it as `main.ts` does, which the test setup
 * otherwise silences (`jest.setup.cjs`). Both refusal paths are driven over
 * HTTP: a hold placed with a transaction, and a settlement with no hold.
 */
describe('refused spends in the debug log', () => {
  let harness: ApiHarness;
  let http: Server;
  const lines: string[] = [];

  const payer = apiTenant('LOG-PAYER');
  const payee = apiTenant('LOG-PAYEE');
  const asPayer = () => `Bearer ${admin(payer)}`;

  // The balance, and two requests above it: amounts nothing else here holds.
  const FUNDED = '918273645';
  const HOLD_REQUESTED = '5463728190';
  const SETTLE_REQUESTED = '7364519280';

  /** A sentinel as a whole number, so no generated id can hold it by chance (#452). */
  const wholeNumber = (digits: string) => new RegExp(`(?<![0-9A-Za-z])${digits}(?![0-9A-Za-z])`);

  const rejected = (code: string) =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.errorCode === code);

  beforeAll(async () => {
    const capture = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
        done();
      },
    });
    harness = await startApi({ environment: { LOG_LEVEL: 'debug' }, logDestination: capture });
    http = harness.app.getHttpServer() as Server;

    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', asPayer())
      .expect(200);
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('log-fund'))
      .send({ amountMinor: FUNDED })
      .expect(201);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee]);
    await harness.close();
  });

  it('logs the wallet and a fixed reason for a hold the balance cannot cover', async () => {
    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asPayer());
    const response = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', id('log-hold'))
      .send({
        transactionType: 'MAINTENANCE_SERVICE',
        businessLine: 'MAINTENANCE',
        counterpartyOrganizationId: payee,
        grossAmountMinor: HOLD_REQUESTED,
        currency: 'IRR',
        holdFunds: true,
      })
      .expect(422);
    expect(response.body.code).toBe('INSUFFICIENT_BALANCE');

    const [line] = rejected('INSUFFICIENT_BALANCE');
    expect(line).toMatchObject({
      level: 'debug',
      msg: 'Request rejected: INSUFFICIENT_BALANCE',
      internalContext: { walletId: wallet.body.id, reason: 'AVAILABLE_BELOW_REQUESTED' },
    });
    expect(Object.keys(line!.internalContext as object).sort()).toEqual(['reason', 'walletId']);
  });

  it('logs no figure for a settlement with no hold that the balance cannot cover', async () => {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', id('log-obligation'))
      .send({
        transactionType: 'MAINTENANCE_SERVICE',
        businessLine: 'MAINTENANCE',
        counterpartyOrganizationId: payee,
        grossAmountMinor: SETTLE_REQUESTED,
        currency: 'IRR',
        holdFunds: false,
      })
      .expect(201);
    await request(http)
      .post(`/v1/transactions/${created.body.id}/authorise-settlement`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('log-authorise'))
      .expect(200);
    const refused = await request(http)
      .post('/v1/settlements')
      .set('authorization', asPayer())
      .set('idempotency-key', id('log-settle'))
      .send({ transactionId: created.body.id })
      .expect(422);
    expect(refused.body.code).toBe('INSUFFICIENT_BALANCE');

    expect(rejected('INSUFFICIENT_BALANCE')).toHaveLength(2);
    // Nest's own loggers write here too: the settlement's warning is in the
    // same stream, so the capture is the whole of what the service logged.
    expect(lines.some((line) => line.includes(`Settlement of ${created.body.id} failed`))).toBe(
      true,
    );
  });

  it('wrote none of the amounts anywhere in the log', () => {
    // The capture is not vacuous: debug lines reached it.
    expect(lines.some((line) => line.includes('"level":"debug"'))).toBe(true);
    expectNotDisclosed(lines, [FUNDED, HOLD_REQUESTED, SETTLE_REQUESTED].map(wholeNumber));
  });
});
