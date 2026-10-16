import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped, tryGetContext } from '@rasta/nest-common';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * Only the request that reserved a key may complete it, refuse it or release
 * it (review of #287, finding 2; docs/23 D-054).
 *
 * The interleaving the review reproduced, made exact with barriers — no
 * sleeps, no timing:
 *
 *   1. request A reserves K and is held just before its effect's transaction;
 *   2. A's reservation expires (back-dated here: the TTL is hours long);
 *   3. request B — the same key, another body — removes the expired row,
 *      reserves K afresh, and is held at the same point;
 *   4. A resumes.
 *
 * Before the fix A's completion matched by key and state alone, found B's
 * reservation `IN_PROGRESS`, and committed A's effect and answer under it; B
 * then lost its own completion, and every retry of B replayed A's answer —
 * `"7000"` for a request of `"9000"`. A failed A released B's claim the same
 * way, leaving the key free while B ran. Now each reservation has its own
 * token: A's completion matches nothing, so A's effect rolls back with a
 * retryable conflict, and B's claim is left to B.
 */
describe('which request may complete an idempotency claim (HTTP)', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('CLAIM-OWNER');
  const payee = apiTenant('CLAIM-PAYEE');
  // One person sends both requests: same actor, same key, two bodies.
  const asPayer = () => `Bearer ${admin(payer)}`;
  const ENDPOINT = 'POST /v1/transactions';

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    // Listening already, so supertest neither starts nor closes it per
    // request: its callback waits for that close, which would wait for the
    // other request — held at its barrier — and never come.
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  });

  /** Opens every barrier still shut, so a failed assertion strands no request. */
  let releaseAll: () => void = () => undefined;

  afterEach(() => {
    releaseAll();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee]);
    await harness.close();
  });

  /** A promise and the function that settles it. */
  function barrier<T = void>() {
    let open!: (value: T) => void;
    const reached = new Promise<T>((resolve) => {
      open = resolve;
    });
    return { reached, open };
  }

  /**
   * Holds the n-th effect transaction `payer`'s requests open, from now on,
   * until the test lets it go: `arrived[n]` resolves when request n gets
   * there, and `release(n, outcome)` lets it run — or fail before it starts.
   * The claim's own short transactions are not `PrismaService.transaction`,
   * so only effects are counted.
   */
  function holdEffects(count: number) {
    const original = harness.prisma.transaction.bind(harness.prisma);
    const arrived = Array.from({ length: count }, () => barrier());
    const gates = Array.from({ length: count }, () => barrier<'run' | 'fail'>());
    let seen = 0;
    jest.spyOn(harness.prisma, 'transaction').mockImplementation((async (
      fn: Parameters<typeof original>[0],
    ) => {
      if (tryGetContext()?.organizationId !== payer || seen >= count) return original(fn);
      const n = seen;
      seen += 1;
      arrived[n]!.open();
      if ((await gates[n]!.reached) === 'fail') {
        throw new Error('injected: the effect failed before it began');
      }
      return original(fn);
    }) as typeof original);
    releaseAll = () => gates.forEach((gate) => gate.open('run'));
    return {
      arrived: (n: number) => arrived[n]!.reached,
      release: (n: number, outcome: 'run' | 'fail' = 'run') => gates[n]!.open(outcome),
    };
  }

  const create = (key: string, grossAmountMinor: string) =>
    request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', key)
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor,
        currency: 'IRR',
      });

  /** Starts a request now; the response is awaited later. */
  const started = (test: request.Test) =>
    new Promise<request.Response>((resolve, reject) => {
      test.end((error, response) => (error ? reject(error) : resolve(response)));
    });

  const expire = (key: string) =>
    runUnscoped('the suite expires the first reservation it holds', () =>
      harness.prisma.client.$executeRawUnsafe(
        `UPDATE idempotency_key
            SET created_at = now() - interval '48 hours',
                expires_at = now() - interval '24 hours'
          WHERE organization_id = $1 AND endpoint = $2 AND key = $3`,
        payer,
        ENDPOINT,
        key,
      ),
    );

  const record = (key: string) =>
    runUnscoped('the suite reads the idempotency record', () =>
      harness.prisma.client.idempotencyKey.findFirst({
        where: { organizationId: payer, endpoint: ENDPOINT, key },
      }),
    );

  const obligations = (key: string) =>
    runUnscoped('the suite reads the obligations made under the key', () =>
      harness.prisma.client.transaction.findMany({
        where: { organizationId: payer, idempotencyKey: key },
        select: { id: true, grossAmountMinor: true },
      }),
    );

  it('an expired request cannot complete the claim that replaced its own', async () => {
    const key = id('owner-complete');
    const effects = holdEffects(2);

    // 1. A reserves K and waits at its effect.
    const a = started(create(key, '7000'));
    await effects.arrived(0);

    // 2–3. A's reservation lapses; B takes K over and waits at its effect.
    await expire(key);
    const b = started(create(key, '9000'));
    await effects.arrived(1);
    const reservedByB = await record(key);
    expect(reservedByB).toMatchObject({ state: 'IN_PROGRESS' });

    // 4. A resumes: its effect rolls back, with a retryable conflict.
    effects.release(0);
    const answeredA = await a;
    expect(answeredA.status).toBe(409);
    expect(answeredA.body.code).toBe('CONFLICT');
    expect(answeredA.headers['retry-after']).toBe('1');
    expect(await obligations(key)).toEqual([]);
    // B's reservation is untouched — neither completed nor released by A.
    expect(await record(key)).toMatchObject({
      state: 'IN_PROGRESS',
      claimToken: reservedByB!.claimToken,
    });

    // B finishes as the key's one owner.
    effects.release(1);
    const answeredB = await b;
    expect(answeredB.status).toBe(201);
    expect(answeredB.body).toMatchObject({ grossAmountMinor: '9000' });

    // B's retry replays B's answer; one obligation exists, B's.
    const replay = await create(key, '9000').expect(201);
    expect(replay.body).toEqual(answeredB.body);
    const made = await obligations(key);
    expect(made).toHaveLength(1);
    expect(made[0]!.id).toBe(answeredB.body.id);
    expect(made[0]!.grossAmountMinor).toBe(9000n);

    // A's own retry is now another body under B's key.
    const retryA = await create(key, '7000').expect(409);
    expect(retryA.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('an expired request whose work failed cannot release the claim that replaced its own', async () => {
    const key = id('owner-release');
    const effects = holdEffects(2);

    const a = started(create(key, '7000'));
    await effects.arrived(0);
    await expire(key);
    const b = started(create(key, '9000'));
    await effects.arrived(1);
    const reservedByB = await record(key);

    // A fails and releases what it reserved — which is no longer there.
    effects.release(0, 'fail');
    expect((await a).status).toBe(500);
    expect(await record(key)).toMatchObject({
      state: 'IN_PROGRESS',
      claimToken: reservedByB!.claimToken,
    });

    // The key is still B's: a third request is told it is in flight.
    const third = await create(key, '9000').expect(409);
    expect(third.body.code).toBe('CONFLICT');

    effects.release(1);
    expect((await b).status).toBe(201);
    expect(await obligations(key)).toHaveLength(1);
  });
});
