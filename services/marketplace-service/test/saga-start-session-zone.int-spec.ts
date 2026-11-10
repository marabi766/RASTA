import { ZONE_SWITCHES, inSessionZone, setTenantEligibilityFixture } from '@rasta/testing';
import { SagaStartStore } from '../src/temporal/saga-start.store';
import { asActor, cleanup, key, newPrisma, publishOffer, tenants, wire } from './helpers';

/**
 * `age_ms` decides whether `describe()` guards `workflow.start` near the namespace
 * retention (saga.client.ts): understated by a zone's offset, an order's saga could run
 * twice. So the lease, the retry and the age do not depend on the session's zone (FU-188).
 */
describe('order saga_start deadlines in any session zone (PostgreSQL)', () => {
  const prisma = newPrisma();
  const wiring = wire(prisma);
  const org = tenants();

  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.stop();
  });

  const place = async () => {
    const { offerId } = await publishOffer(wiring, org.supplier);
    return asActor({ organizationId: org.buyer }, () =>
      wiring.orders.place({ lines: [{ offerId, offerVersion: 1, quantity: 2 }] }, key('zone')),
    );
  };

  it.each(ZONE_SWITCHES)('a claim written in %s and read in %s', async (first, second) => {
    const order = await place();
    const only = { id: order.id, organizationId: org.buyer };
    const row = `"order" WHERE id = $1`;
    // A first attempt, in UTC and committed, so the age below is a real one: on the first
    // claim attempted_at is this very instant, and GREATEST(0, ...) hides an understated age.
    await new SagaStartStore(prisma).claim(only);
    await setTenantEligibilityFixture(prisma, 'sagaStartDueAndExpired', org.buyer, [order.id]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await inSessionZone(prisma, async ({ db, tx, zone, secondsFromNow }) => {
      const store = new SagaStartStore(db);

      await zone(first);
      const [claim] = await store.claim(only);
      expect(claim?.id).toBe(order.id);
      expect(
        Math.abs((await secondsFromNow('saga_start_claim_expires_at', row, order.id)) - 30),
      ).toBeLessThan(2);
      // Not older, or younger, by an offset: understated, GREATEST(0, ...) would make it 0.
      expect(claim!.age_ms).toBeGreaterThan(0);
      expect(claim!.age_ms).toBeLessThan(60_000);

      // Mid-lease, in the other zone.
      await zone(second);
      expect(await store.claim(only)).toEqual([]);
      // The gauge reads the wait of the oldest open order, whichever zone reads it.
      const [expected] = await tx.$queryRawUnsafe<{ age: number }[]>(
        `SELECT EXTRACT(EPOCH FROM (clock_timestamp() AT TIME ZONE 'UTC') - min(created_at))::float8 AS age
           FROM "order" WHERE saga_start_delivered_at IS NULL AND status IN ('PENDING', 'CANCELLING')`,
      );
      expect(Math.abs((await store.backlog()).age - expected!.age)).toBeLessThan(5);

      // A live lease can finish in either zone; the retry is 30 s away.
      expect(await store.finish(claim!, false)).toBe(1);
      expect(
        Math.abs((await secondsFromNow('saga_start_next_attempt_at', row, order.id)) - 30),
      ).toBeLessThan(2);
      await zone(first);
      expect(await store.claim(only)).toEqual([]);
    });
  });

  it.each(['Asia/Tehran', 'America/Los_Angeles'])('the delivery stamp in %s', async (zoneName) => {
    const order = await place();
    await inSessionZone(prisma, async ({ db, zone, secondsFromNow }) => {
      const store = new SagaStartStore(db);
      await zone(zoneName);
      const [claim] = await store.claim({ id: order.id, organizationId: org.buyer });
      const attempted = await secondsFromNow(
        'saga_start_attempted_at',
        `"order" WHERE id = $1`,
        order.id,
      );
      expect(Math.abs(attempted)).toBeLessThan(2);
      expect(await store.finish(claim!, true)).toBe(1);
      const at = await secondsFromNow('saga_start_delivered_at', `"order" WHERE id = $1`, order.id);
      expect(Math.abs(at)).toBeLessThan(2);
    });
  });

  it.each(['Asia/Tehran', 'America/Los_Angeles', 'UTC'])(
    'the first due time defaults to UTC wall time in %s',
    async (zoneName) => {
      await inSessionZone(prisma, async ({ tx, zone }) => {
        const [{ expression } = { expression: '' }] = await tx.$queryRawUnsafe<
          { expression: string }[]
        >(
          `SELECT pg_get_expr(d.adbin, d.adrelid) AS expression
             FROM pg_attrdef d
             JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
            WHERE d.adrelid = '"order"'::regclass AND a.attname = 'saga_start_next_attempt_at'`,
        );
        await zone(zoneName);
        const [row] = await tx.$queryRawUnsafe<{ off: number }[]>(
          `SELECT EXTRACT(EPOCH FROM (${expression})::timestamp(3)
             - (now() AT TIME ZONE 'UTC'))::float8 AS off`,
        );
        expect(Math.abs(row!.off)).toBeLessThan(0.002);
      });
    },
  );
});
