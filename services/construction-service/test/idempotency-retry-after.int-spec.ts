import request from 'supertest';
import type { Server } from 'node:http';
import { IdempotencyStore } from '../src/shared/idempotency';
import { apiTenant, orgAdmin, startApi, type ApiHarness } from './api-helpers';
import { PROJECT, cleanup } from './helpers';

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
  let api: ApiHarness;
  let http: Server;
  let store: IdempotencyStore;

  const org = apiTenant('INFLIGHT-A');
  const other = apiTenant('INFLIGHT-B');

  beforeAll(async () => {
    api = await startApi();
    // Listening before the first request, so two requests in flight at once
    // share one server rather than each asking supertest to start it.
    await api.app.listen(0, '127.0.0.1');
    http = api.app.getHttpServer() as Server;
    store = api.app.get(IdempotencyStore);
  });

  afterAll(async () => {
    await cleanup(api.prisma, [org, other]);
    await api.close();
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

  const createProject = (organizationId: string, key: string, body: object = PROJECT) =>
    request(http)
      .post('/v1/projects')
      .set('authorization', `Bearer ${orgAdmin(organizationId)}`)
      .set('idempotency-key', key)
      .send(body);

  it('the second of two concurrent requests is told to wait, and the first completes once', async () => {
    const key = 'inflight-create-project';
    const gate = holdFirstClaim();
    const first = createProject(org, key).then((response) => response);

    try {
      await gate.claimed;

      const second = await createProject(org, key);
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
      const foreign = await createProject(other, key);
      expect(foreign.status).toBe(201);
      expect(foreign.body.organizationId).toBe(other);
      expect(foreign.headers['retry-after']).toBeUndefined();

      gate.release();
      const done = await first;
      expect(done.status).toBe(201);
      expect(done.headers['retry-after']).toBeUndefined();

      // The retry the header asked for: the stored response, not a second project.
      const retried = await createProject(org, key);
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
    const key = 'inflight-reused-project';
    await createProject(org, key).expect(201);

    const reused = await createProject(org, key, { ...PROJECT, title: 'Different' });

    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(reused.headers['retry-after']).toBeUndefined();
  });

  it.each(['__proto__', 'constructor'])(
    'a body carrying a %s key is refused at the boundary, 400, and claims nothing (#194)',
    async (name) => {
      const key = `proto-${name}-project`;
      const raw = JSON.stringify(PROJECT).replace(/^\{/, `{"${name}":{"x":1},`);
      const refused = await request(http)
        .post('/v1/projects')
        .set('authorization', `Bearer ${orgAdmin(org)}`)
        .set('idempotency-key', key)
        .set('content-type', 'application/json')
        .send(raw);

      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
      // Nothing was claimed: the key is still free for a valid request.
      await createProject(org, key).expect(201);
    },
  );
});
