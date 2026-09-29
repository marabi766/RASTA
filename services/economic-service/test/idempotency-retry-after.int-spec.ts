import request from 'supertest';
import type { Server } from 'node:http';
import { IdempotencyStore } from '../src/shared/idempotency';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * docs/06 § 6.8 over real HTTP: a request whose Idempotency-Key is still in
 * flight is answered `409 CONFLICT` with `Retry-After: 1`.
 *
 * The documented promise was never kept — the wait sat in the error's
 * server-side context, and the exception filter sends no header from there.
 * Two requests with one key, the first held **after** its claim committed and
 * **before** its work ran, so the second meets the in-flight row every time:
 * no timing, no seeded row, the real claim of a real first request.
 */
describe('an Idempotency-Key in flight: 409 with Retry-After (real HTTP)', () => {
  let harness: ApiHarness;
  let http: Server;
  let store: IdempotencyStore;

  const org = apiTenant('INFLIGHT-A');
  const other = apiTenant('INFLIGHT-B');
  const asOrg = () => `Bearer ${admin(org)}`;
  const asOther = () => `Bearer ${admin(other)}`;

  beforeAll(async () => {
    harness = await startApi();
    // Listening before the first request, so two requests in flight at once
    // share one server rather than each asking supertest to start it.
    await harness.app.listen(0, '127.0.0.1');
    http = harness.app.getHttpServer() as Server;
    store = harness.app.get(IdempotencyStore);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [org, other]);
    await harness.close();
  });

  /**
   * Lets the first claim through, then holds that request until released —
   * its key committed `IN_PROGRESS`, its work not yet begun. Later claims pass
   * straight through.
   */
  function holdFirstClaim(): { claimed: Promise<void>; release: () => void; restore: () => void } {
    let signalClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => (signalClaimed = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const original = store.claim.bind(store);
    let held = false;
    const spy = jest.spyOn(store, 'claim').mockImplementation(async (endpoint, key, body) => {
      const outcome = await original(endpoint, key, body);
      if (!held && outcome.kind === 'PROCEED') {
        held = true;
        signalClaimed();
        await released;
      }
      return outcome;
    });
    return { claimed, release, restore: () => spy.mockRestore() };
  }

  const walletOf = async (token: string): Promise<string> =>
    (await request(http).get('/v1/wallets/me').set('authorization', token).expect(200)).body.id;

  const topUp = (token: string, walletId: string, key: string) =>
    request(http)
      .post(`/v1/wallets/${walletId}/top-up`)
      .set('authorization', token)
      .set('idempotency-key', key)
      .send({ amountMinor: '5000' });

  it('the second of two concurrent requests is told to wait, and the first completes once', async () => {
    const walletId = await walletOf(asOrg());
    const otherWalletId = await walletOf(asOther());
    const key = id('inflight-topup');
    const gate = holdFirstClaim();
    const first = topUp(asOrg(), walletId, key).then((response) => response);

    try {
      await gate.claimed;

      const second = await topUp(asOrg(), walletId, key);
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({
        code: 'CONFLICT',
        message: 'This request is already being processed; retry shortly',
      });
      expect(second.headers['retry-after']).toBe('1');
      // The wait is a header, and nothing of the error's context rides along.
      expect(JSON.stringify(second.body)).not.toMatch(/retryAfter|endpoint/);

      // The in-flight row is this tenant's: another organization using the
      // same key is neither told to wait nor given anything of this one.
      const foreign = await topUp(asOther(), otherWalletId, key);
      expect(foreign.status).toBe(201);
      expect(foreign.headers['retry-after']).toBeUndefined();

      gate.release();
      const done = await first;
      expect(done.status).toBe(201);
      expect(done.headers['retry-after']).toBeUndefined();

      // The retry the header asked for: the stored response, not a second top-up.
      const retried = await topUp(asOrg(), walletId, key);
      expect(retried.status).toBe(201);
      expect(retried.body).toEqual(done.body);
      expect(retried.headers['retry-after']).toBeUndefined();
    } finally {
      // Whatever failed above, the held request finishes inside this test:
      // left running, it would outlive the application and hold Jest open.
      gate.release();
      await first.catch(() => undefined);
      gate.restore();
    }
  });

  it('a key reused with another body is refused without Retry-After: waiting will not help', async () => {
    const walletId = await walletOf(asOrg());
    const key = id('inflight-reused');
    await topUp(asOrg(), walletId, key).expect(201);

    const reused = await request(http)
      .post(`/v1/wallets/${walletId}/top-up`)
      .set('authorization', asOrg())
      .set('idempotency-key', key)
      .send({ amountMinor: '6000' });

    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(reused.headers['retry-after']).toBeUndefined();
  });
});
