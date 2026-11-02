import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import { errorEnvelope, expectNotDisclosed } from '@rasta/testing';
import { apiTenant, orgAdmin, startApi, type ApiHarness } from './api-helpers';
import { PROJECT, cleanup } from './helpers';

/**
 * The replay fence over real HTTP (PM decision D-065): the header's validation, the plumbing from the
 * request to the claim, and the 409 code on the wire. The clock-sensitive behaviour is in
 * `idempotency-replay-fence.int-spec.ts`; here the service's own clock is real, so deadlines are chosen
 * far from now.
 */
describe('Idempotency-Replay-Deadline (real HTTP)', () => {
  let api: ApiHarness;
  let server: http.Server;
  const org = apiTenant('FENCE');

  beforeAll(async () => {
    api = await startApi();
    await api.app.listen(0, '127.0.0.1');
    server = api.app.getHttpServer() as http.Server;
  });

  afterAll(async () => {
    await cleanup(api.prisma, [org]);
    await api.close();
  });

  const token = (): string => orgAdmin(org);
  const projects = () =>
    runUnscoped('count the organization’s projects', () =>
      api.prisma.client.project.findMany({ where: { organizationId: org } }),
    );
  const keyRows = () =>
    runUnscoped('count the organization’s idempotency records', () =>
      api.prisma.client.idempotencyKey.findMany({ where: { organizationId: org } }),
    );
  const inAnHour = (): string => String(Date.now() + 60 * 60 * 1000);

  it('stores the deadline on the first claim, replays inside it, and answers 201 both times', async () => {
    const deadline = inAnHour();
    const auth = token();
    const first = await request(server)
      .post('/v1/projects')
      .set('authorization', `Bearer ${auth}`)
      .set('idempotency-key', 'fence-http-ok')
      .set('idempotency-replay-deadline', deadline)
      .send(PROJECT)
      .expect(201);
    const retry = await request(server)
      .post('/v1/projects')
      .set('authorization', `Bearer ${auth}`)
      .set('idempotency-key', 'fence-http-ok')
      .set('idempotency-replay-deadline', deadline)
      .send(PROJECT)
      .expect(201);
    expect(retry.body).toEqual(first.body);

    const row = (await keyRows()).find((r) => r.key === 'fence-http-ok');
    expect(row?.replayDeadlineAt?.getTime()).toBe(Number(deadline));
  });

  it('a deadline already behind the service clock: 409 REPLAY_WINDOW_CLOSED, nothing written', async () => {
    const before = (await projects()).length;
    const response = await request(server)
      .post('/v1/projects')
      .set('authorization', `Bearer ${token()}`)
      .set('idempotency-key', 'fence-http-late')
      .set('idempotency-replay-deadline', String(Date.now() - 1000))
      .send(PROJECT)
      .expect(409);
    expect(response.body.code).toBe('REPLAY_WINDOW_CLOSED');
    expect(response.headers['retry-after']).toBeUndefined();
    expect((await projects()).length).toBe(before);
    expect((await keyRows()).some((r) => r.key === 'fence-http-late')).toBe(false);
  });

  describe('a header that is not one canonical epoch-ms integer is 400 before any claim', () => {
    it.each([
      ['empty', ''],
      ['a space inside', '1767225 600000'],
      ['a leading zero', '01767225600000'],
      ['a sign', '-1767225600000'],
      ['a plus', '+1767225600000'],
      ['a fraction', '1767225600000.5'],
      ['an exponent', '1.7e12'],
      ['hex', '0x19a2b3c4d5e'],
      ['words', 'tomorrow'],
      ['zero', '0'],
      ['an unsafe integer', '9007199254740993'],
      ['too many digits', '12345678901234567'],
      ['two values joined', '1767225600000, 1767225600001'],
    ])('%s', async (_name, value) => {
      const before = (await keyRows()).length;
      const response = await request(server)
        .post('/v1/projects')
        .set('authorization', `Bearer ${token()}`)
        .set('idempotency-key', 'fence-http-bad')
        .set('idempotency-replay-deadline', value)
        .send(PROJECT)
        .expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect((await keyRows()).length).toBe(before);
    });

    it('a duplicated header line', async () => {
      const response = await rawPost(server, token(), {
        'idempotency-key': 'fence-http-dup',
        'idempotency-replay-deadline': [inAnHour(), inAnHour()],
      });
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body).code).toBe('VALIDATION_FAILED');
    });

    it('a deadline WITHOUT an Idempotency-Key: nothing would be fenced, so nothing runs', async () => {
      const before = (await projects()).length;
      const response = await request(server)
        .post('/v1/projects')
        .set('authorization', `Bearer ${token()}`)
        .set('idempotency-replay-deadline', inAnHour())
        .send(PROJECT)
        .expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect((await projects()).length).toBe(before);
    });
  });

  it('a deadline beyond the retention (D-067): 400 VALIDATION_FAILED with a fixed message, no clamp, nothing written', async () => {
    const before = { projects: (await projects()).length, keys: (await keyRows()).length };
    const tenYears = String(Date.now() + 10 * 365 * 24 * 3600 * 1000);
    const response = await request(server)
      .post('/v1/projects')
      .set('authorization', `Bearer ${token()}`)
      .set('idempotency-key', 'fence-http-far')
      .set('idempotency-replay-deadline', tenYears)
      .send(PROJECT)
      .expect(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    // Nothing of the limit, the clock or any stored value is in the body: the deadline sent is
    // looked for once the envelope's correlation ULID and timestamp are set aside (#452).
    expectNotDisclosed(response.body, [tenYears], {
      metadata: errorEnvelope({ headers: response.headers }),
      input: { 'idempotency-replay-deadline': tenYears },
    });
    expect(JSON.stringify(response.body)).toContain('Idempotency-Replay-Deadline');
    expect({ projects: (await projects()).length, keys: (await keyRows()).length }).toEqual(before);
  });

  it('a request without the header is what it always was: no deadline stored', async () => {
    await request(server)
      .post('/v1/projects')
      .set('authorization', `Bearer ${token()}`)
      .set('idempotency-key', 'fence-http-none')
      .send(PROJECT)
      .expect(201);
    const row = (await keyRows()).find((r) => r.key === 'fence-http-none');
    expect(row?.replayDeadlineAt).toBeNull();
  });
});

/** One POST with header values that may repeat: Node writes each array element as its own header line. */
function rawPost(
  target: http.Server,
  bearer: string,
  headers: Record<string, string | string[]>,
): Promise<{ status: number; body: string }> {
  const { port } = target.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/projects',
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += String(chunk)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(PROJECT));
  });
}
