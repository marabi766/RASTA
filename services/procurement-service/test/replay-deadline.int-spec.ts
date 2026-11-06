import request from 'supertest';
import { actor, buyer, client, key } from './api-helpers';
import { newProductId, runtimeClient } from './helpers';
import { startRfqApi, type RfqHarness } from './rfq-helpers';

/**
 * The replay fence (FU-156, PM decision D-125; PR-830 r1 F2): every keyed command reads
 * `Idempotency-Replay-Deadline` through the one store (`shared/idempotency.ts`), and a request past
 * it — or asking for more than the retention can keep — is refused before anything is executed.
 */
describe('Idempotency-Replay-Deadline', () => {
  let h: RfqHarness;
  const runtime = runtimeClient();
  const DEADLINE = 'idempotency-replay-deadline';
  /** B with the default skew: 2 · 30 s + 7 s. */
  const BUDGET_MS = 67_000;
  /** The default retention (PROCUREMENT_IDEMPOTENCY_TTL_HOURS = 24). */
  const TTL_MS = 24 * 3_600_000;

  const demandsOf = (organizationId: string) =>
    runtime.demandRequest.count({ where: { organizationId } });
  const keysOf = (organizationId: string) =>
    runtime.idempotencyKey.findMany({ where: { organizationId } });
  const waitUntilPast = async (instantMs: number) => {
    while (Date.now() <= instantMs) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(5, instantMs - Date.now() + 5)));
    }
  };

  beforeAll(async () => {
    h = await startRfqApi();
  });

  afterAll(async () => {
    await h.close();
    await runtime.$disconnect();
  });

  beforeEach(() => h.clock.set(null));

  it('reviewer probe (PR-830 r1 F2): a retry delayed past the retention is refused, never a second demand', async () => {
    const organizationId = h.org();
    const as = client(h.api, buyer(organizationId));
    const body = { productId: newProductId(), quantity: 3 };
    const k = key();
    // The portal's stored deadline: here 1.5 s ahead (the reviewer's run: 2 969 000 ms into a
    // 3 600 000 ms retention).
    const deadline = String(Date.now() + 1_500);

    const first = await as.post('/v1/demand-requests', body, k).set(DEADLINE, deadline);
    expect(first.status).toBe(201);
    const [stored] = await keysOf(organizationId);
    // Kept at least B past the deadline, whatever the retention.
    expect(stored!.expiresAt.getTime()).toBeGreaterThanOrEqual(Number(deadline) + BUDGET_MS);

    // The retention elapses (the reviewer's 3 601 000 ms): the stored response is now reclaimable,
    // as the purge or a claim's takeover would find it.
    await runtime.idempotencyKey.updateMany({
      where: { organizationId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await waitUntilPast(Number(deadline));

    // The same request, same key, same deadline — delayed before admission.
    const retry = await as.post('/v1/demand-requests', body, k).set(DEADLINE, deadline);
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ code: 'REPLAY_WINDOW_CLOSED' });
    expect(await demandsOf(organizationId)).toBe(1);
    // Nothing was read or written by the refused attempt: the old row is untouched.
    expect((await keysOf(organizationId)).map((row) => row.claimToken)).toEqual([
      stored!.claimToken,
    ]);
  });

  it('admits on the database clock after the insert: a deadline behind it rolls the claim back; equality is admitted', async () => {
    const organizationId = h.org();
    const as = client(h.api, buyer(organizationId));
    const deadline = Date.now() + 60_000;

    // This replica's clock passes the deadline check; the database clock read after the insert
    // does not (a request suspended between the two).
    h.clock.set(new Date(deadline + 1));
    const late = await as
      .post('/v1/demand-requests', { productId: newProductId(), quantity: 1 }, key())
      .set(DEADLINE, String(deadline));
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: 'REPLAY_WINDOW_CLOSED' });
    expect(await keysOf(organizationId)).toEqual([]);
    expect(await demandsOf(organizationId)).toBe(0);

    h.clock.set(new Date(deadline));
    const onTime = await as
      .post('/v1/demand-requests', { productId: newProductId(), quantity: 1 }, key())
      .set(DEADLINE, String(deadline));
    expect(onTime.status).toBe(201);
    expect(await demandsOf(organizationId)).toBe(1);
  });

  it('refuses a deadline later than the retention less B with 400 beyond_retention, nothing written; accepts one inside it', async () => {
    const organizationId = h.org();
    const as = client(h.api, buyer(organizationId));

    const tooLate = await as
      .post('/v1/demand-requests', { productId: newProductId(), quantity: 1 }, key())
      .set(DEADLINE, String(Date.now() + TTL_MS - BUDGET_MS + 60_000));
    expect(tooLate.status).toBe(400);
    expect(tooLate.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'Idempotency-Replay-Deadline', code: 'beyond_retention' }],
    });
    expect(await keysOf(organizationId)).toEqual([]);
    expect(await demandsOf(organizationId)).toBe(0);

    const inside = Date.now() + TTL_MS - BUDGET_MS - 60_000;
    const accepted = await as
      .post('/v1/demand-requests', { productId: newProductId(), quantity: 1 }, key())
      .set(DEADLINE, String(inside));
    expect(accepted.status).toBe(201);
    const [row] = await keysOf(organizationId);
    expect(row!.expiresAt.getTime()).toBeGreaterThanOrEqual(inside + BUDGET_MS);
  });

  it('refuses a malformed deadline with 400 invalid before any claim', async () => {
    const organizationId = h.org();
    const response = await client(h.api, buyer(organizationId))
      .post('/v1/demand-requests', { productId: newProductId(), quantity: 1 }, key())
      .set(DEADLINE, '01700000000000');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      details: [{ path: 'Idempotency-Replay-Deadline', code: 'invalid' }],
    });
    expect(await keysOf(organizationId)).toEqual([]);
  });

  it('a stored response is not replayed past its deadline either', async () => {
    const organizationId = h.org();
    const as = client(h.api, buyer(organizationId));
    const body = { productId: newProductId(), quantity: 2 };
    const k = key();
    const deadline = String(Date.now() + 1_000);
    expect((await as.post('/v1/demand-requests', body, k).set(DEADLINE, deadline)).status).toBe(
      201,
    );
    await waitUntilPast(Number(deadline));
    const replay = await as.post('/v1/demand-requests', body, k).set(DEADLINE, deadline);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ code: 'REPLAY_WINDOW_CLOSED' });
  });

  it('is enforced by every keyed command, before its work: a past deadline executes nothing', async () => {
    const organizationId = h.org();
    // Every role a command asks for: the refusal must be the fence's, not an access check's.
    const token = actor(organizationId, ['PROCUREMENT_USER', 'ORGANIZATION_ADMIN', 'SUPPLIER']);
    const as = client(h.api, token);
    const past = String(Date.now() - 1);
    const missing = 'RFQ_00000000000000000000000000';
    const commands: [string, object][] = [
      ['/v1/demand-requests', { productId: newProductId(), quantity: 1 }],
      [`/v1/demand-requests/${missing}/withdraw`, { expectedVersion: 1, reason: 'not needed' }],
      [`/v1/aggregations/${missing}/cancel`, { expectedVersion: 1, reason: 'not needed' }],
      [
        '/v1/aggregation-settings',
        {
          windowHours: 24,
          minQuantity: 0,
          shortfallPolicy: 'EXTEND',
          expectedCurrentVersion: null,
        },
      ],
      [`/v1/aggregations/${missing}/rfq`, h.issueBody({ version: 1 })],
      [`/v1/rfqs/${missing}/close`, {}],
      [
        `/v1/rfqs/${missing}/cancel`,
        { expectedVersion: 1, reasonCode: 'BUYER_REQUEST', reason: 'no budget' },
      ],
      [`/v1/rfqs/${missing}/quotations/mine/withdraw`, { expectedRevision: 1 }],
    ];
    for (const [path, body] of commands) {
      const response = await as.post(path, body).set(DEADLINE, past);
      expect({ path, status: response.status, code: response.body.code }).toEqual({
        path,
        status: 409,
        code: 'REPLAY_WINDOW_CLOSED',
      });
    }
    // The one PUT: a quotation (its keyed hasher included).
    const put = await request(h.api.app.getHttpServer())
      .put(`/v1/rfqs/${missing}/quotations/mine`)
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', key())
      .set(DEADLINE, past)
      .send({
        content: { unitPriceMinor: '10', answers: [{ criterionCode: 'PRICE', answer: 'x' }] },
      });
    expect({ status: put.status, code: put.body.code }).toEqual({
      status: 409,
      code: 'REPLAY_WINDOW_CLOSED',
    });
    expect(await keysOf(organizationId)).toEqual([]);
  });
});
