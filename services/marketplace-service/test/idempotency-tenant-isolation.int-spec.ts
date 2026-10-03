import { runUnscoped } from '@rasta/nest-common';
import { asActor, cleanup, key, newPrisma, tenants, wire, type Wiring } from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * The idempotency store's tenant isolation, against a real database (#173).
 *
 * Until #173 the tenant guard was **not** applied to this table: the list named
 * `IdempotencyRecord` and the model is `IdempotencyKey`, and the guard passes a
 * name it does not know straight through. The store's own queries all state the
 * organization, so nothing leaked — but the layer behind them was off. This
 * proves both layers now:
 *
 *  1. the store: the same key and endpoint under two organizations are two
 *     reservations, a reply is never another tenant's, and one tenant's
 *     `complete` / `release` cannot touch another's row;
 *  2. the guard: a query on the table with no organization in scope is refused
 *     instead of answered, and so is one that names a different organization
 *     than the request's — which is what the missing guard would have let by.
 */
describe('the idempotency store keeps tenants apart (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();
  const ENDPOINT = 'POST /v1/orders';

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
  });

  const store = () => wiring.idempotency;
  const as = <T>(organizationId: string, fn: () => Promise<T>) => asActor({ organizationId }, fn);

  const rowsFor = (organizationId: string, k: string) =>
    runUnscoped(
      'the test reads the stored rows to see what each tenant holds',
      async () =>
        await prisma.client.idempotencyKey.findMany({ where: { organizationId, key: k } }),
    );

  it('treats one key under two organizations as two reservations', async () => {
    const k = key('shared');
    const body = { sku: 'same-body' };

    const a = await as(org.buyer, () => store().claim(ENDPOINT, k, body));
    const b = await as(org.other, () => store().claim(ENDPOINT, k, body));

    expect(a.kind).toBe('PROCEED');
    expect(b.kind).toBe('PROCEED');
    expect((await rowsFor(org.buyer, k)).length).toBe(1);
    expect((await rowsFor(org.other, k)).length).toBe(1);
  });

  it("never replays one tenant's stored response to another", async () => {
    const k = key('reply');
    const claim = await as(org.buyer, () => store().claim(ENDPOINT, k, { n: 1 }));
    if (claim.kind !== 'PROCEED') throw new Error('expected to own the key');
    await as(org.buyer, () =>
      store().complete(ENDPOINT, k, claim.token, 201, { secret: 'A-only' }),
    );

    // The owner replays its own response.
    const replay = await as(org.buyer, () => store().claim(ENDPOINT, k, { n: 1 }));
    expect(replay).toMatchObject({ kind: 'REPLAY', status: 201, body: { secret: 'A-only' } });

    // Another tenant with the same key gets a fresh reservation, not that response.
    const other = await as(org.other, () => store().claim(ENDPOINT, k, { n: 1 }));
    expect(other.kind).toBe('PROCEED');
    expect(JSON.stringify(other)).not.toContain('A-only');
  });

  it("cannot be completed or released by another tenant, even holding the first tenant's token", async () => {
    const k = key('token');
    const claim = await as(org.buyer, () => store().claim(ENDPOINT, k, { n: 2 }));
    if (claim.kind !== 'PROCEED') throw new Error('expected to own the key');

    await as(org.other, () => store().complete(ENDPOINT, k, claim.token, 200, { stolen: true }));
    await as(org.other, () => store().release(ENDPOINT, k, claim.token));

    const [row] = await rowsFor(org.buyer, k);
    expect(row).toMatchObject({ state: 'IN_PROGRESS', responseStatus: null });
  });

  describe('the tenant guard on the table', () => {
    it('refuses a query with no organization in scope', async () => {
      await expect(prisma.client.idempotencyKey.findMany({ where: { key: 'x' } })).rejects.toThrow(
        /RequestContext|organization/i,
      );
    });

    it("refuses a write that names another organization than the request's", async () => {
      await expect(
        as(
          org.buyer,
          async () =>
            // Awaited inside the scope: a Prisma call is lazy, and one awaited
            // outside it would be refused for having no request at all.
            await prisma.client.idempotencyKey.create({
              data: {
                key: key('forged'),
                organizationId: org.other,
                endpoint: ENDPOINT,
                requestHash: 'h',
                state: 'IN_PROGRESS',
                expiresAt: new Date(Date.now() + 60_000),
              },
            }),
        ),
      ).rejects.toThrow();
    });

    it("does not let a read through another organization's scope see the first tenant's rows", async () => {
      const k = key('scope');
      await as(org.buyer, () => store().claim(ENDPOINT, k, { n: 3 }));

      const seen = await as(
        org.other,
        async () =>
          // Awaited inside the scope, as above.
          await prisma.client.idempotencyKey.findMany({ where: { key: k } }),
      );
      expect(seen).toEqual([]);
    });
  });

  it.each(['__proto__', 'constructor'])(
    'refuses a body that differs only under a %s key, and replays the same body (#194)',
    async (name) => {
      const k = key(`proto-${name}`);
      // JSON.parse makes `name` an own key, as the request body parser does.
      const body = (x: number): unknown => ({
        lines: [{ offerId: 'OFR-ITEST', quantity: 1 }],
        extra: JSON.parse(`{"${name}":{"x":${x}}}`) as unknown,
      });
      const claim = await as(org.buyer, () => store().claim(ENDPOINT, k, body(1)));
      if (claim.kind !== 'PROCEED') throw new Error('expected to own the key');
      await as(org.buyer, () => store().complete(ENDPOINT, k, claim.token, 201, { id: 'ORD-1' }));

      await expect(as(org.buyer, () => store().claim(ENDPOINT, k, body(2)))).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      expect(await as(org.buyer, () => store().claim(ENDPOINT, k, body(1)))).toMatchObject({
        kind: 'REPLAY',
        body: { id: 'ORD-1' },
      });
    },
  );
});
