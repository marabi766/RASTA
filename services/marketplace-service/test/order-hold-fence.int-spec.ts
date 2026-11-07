import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withUtcSession } from '@rasta/config';
import { runUnscoped } from '@rasta/nest-common';
import { Prisma, PrismaClient } from '../src/generated/prisma';
import { asActor, cleanup, key, newPrisma, publishOffer, tenants, wire } from './helpers';

/** The hold's fence on the order row (D-144), against the real database. */
const HOUR = 3_600_000;
const MIGRATION = '20261107120000_order_hold_fence';

describe('the hold fence on the order row (PostgreSQL)', () => {
  const prisma = newPrisma();
  const wiring = wire(prisma);
  const org = tenants();
  let owner: PrismaClient;

  beforeAll(() => {
    const url = process.env.DATABASE_URL_MARKETPLACE_MIGRATOR;
    if (!url) throw new Error('DATABASE_URL_MARKETPLACE_MIGRATOR is required by this suite');
    owner = new PrismaClient({ datasources: { db: { url: withUtcSession(url) } } });
  });
  afterAll(async () => {
    await owner.$disconnect();
    await cleanup(prisma, [org.buyer, org.supplier]);
    await prisma.onModuleDestroy();
  });

  async function place() {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const placed = await asActor({ organizationId: org.buyer }, () =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('fence')),
    );
    return { id: placed.id, organizationId: org.buyer };
  }
  const row = (order: { id: string }) =>
    runUnscoped('the test reads the row it wrote', () =>
      prisma.client.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { holdNotAfter: true, holdSendClaims: true, holdSendsClosedAt: true },
      }),
    );
  const write = (order: { id: string }, data: Prisma.OrderUpdateInput) =>
    owner.order.update({ where: { id: order.id }, data });
  const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();

  describe('claimHoldSend', () => {
    it('sets the deadline once, before anything else can read it, and counts every send', async () => {
      const order = await place();
      const first = fromNow(24 * HOUR);
      expect(await row(order)).toMatchObject({ holdNotAfter: null, holdSendClaims: 0 });
      expect(await wiring.orders.claimHoldSend(order, first)).toEqual({
        holdNotAfter: first,
        claims: 1,
      });
      expect(await wiring.orders.claimHoldSend(order, fromNow(48 * HOUR))).toEqual({
        holdNotAfter: first,
        claims: 2,
      });
      expect((await row(order)).holdNotAfter?.toISOString()).toBe(first);
    });

    it('concurrent sends each get their own count, and one deadline', async () => {
      const order = await place();
      const claims = await Promise.all(
        [1, 2, 3, 4].map((n) => wiring.orders.claimHoldSend(order, fromNow(n * HOUR))),
      );
      const counted = claims.map((claim) => {
        if ('closed' in claim) throw new Error('refused');
        return claim;
      });
      expect(counted.map((claim) => claim.claims).sort()).toEqual([1, 2, 3, 4]);
      expect(new Set(counted.map((claim) => claim.holdNotAfter)).size).toBe(1);
    });

    it('a send proposing nothing fixes nothing, and no later one can', async () => {
      const order = await place();
      expect(await wiring.orders.claimHoldSend(order, undefined)).toEqual({
        holdNotAfter: null,
        claims: 1,
      });
      expect(await wiring.orders.claimHoldSend(order, fromNow(HOUR))).toEqual({
        holdNotAfter: null,
        claims: 2,
      });
    });

    it('another organization’s name claims nothing', async () => {
      const order = await place();
      expect(
        await wiring.orders.claimHoldSend(
          { ...order, organizationId: org.supplier },
          fromNow(HOUR),
        ),
      ).toEqual({ closed: false });
      expect((await row(order)).holdSendClaims).toBe(0);
    });

    it.each(['FAILED', 'CANCELLED'] as const)(
      'an order %s claims nothing, and says not closed',
      async (status) => {
        const order = await place();
        await write(
          order,
          status === 'FAILED'
            ? { status, failureReason: 'refused' }
            : {
                status,
                cancelledAt: new Date(),
                cancellationReason: 'changed their mind',
                cancellationCause: 'BUYER',
              },
        );
        expect(await wiring.orders.claimHoldSend(order, fromNow(HOUR))).toEqual({ closed: false });
        expect((await row(order)).holdSendClaims).toBe(0);
      },
    );
  });

  describe('closeHoldSendsOnRefusal', () => {
    it('after the only send: true, and no send can begin', async () => {
      const order = await place();
      await wiring.orders.claimHoldSend(order, fromNow(HOUR));
      expect(await wiring.orders.closeHoldSendsOnRefusal(order)).toBe(true);
      expect(await wiring.orders.claimHoldSend(order, fromNow(HOUR))).toEqual({ closed: true });
      expect((await row(order)).holdSendClaims).toBe(1);
    });

    it('another send since: false, and sends stay open', async () => {
      const order = await place();
      await wiring.orders.claimHoldSend(order, fromNow(HOUR));
      await wiring.orders.claimHoldSend(order, fromNow(HOUR));
      expect(await wiring.orders.closeHoldSendsOnRefusal(order)).toBe(false);
      expect((await row(order)).holdSendsClosedAt).toBeNull();
    });
  });

  describe('closeHoldSendsIfNoneCanLand', () => {
    const can = (order: { id: string; organizationId: string }) =>
      wiring.orders.closeHoldSendsIfNoneCanLand(order, HOUR);

    it('no send ever began: true, and a send arriving later is shut out', async () => {
      const order = await place();
      expect(await can(order)).toBe(true);
      expect(await wiring.orders.claimHoldSend(order, fromNow(HOUR))).toEqual({ closed: true });
    });

    it('a deadline to come, or inside its margin: false', async () => {
      const coming = await place();
      await wiring.orders.claimHoldSend(coming, fromNow(HOUR));
      expect(await can(coming)).toBe(false);
      const inMargin = await place();
      await wiring.orders.claimHoldSend(inMargin, fromNow(-HOUR / 2));
      expect(await can(inMargin)).toBe(false);
      expect((await row(inMargin)).holdSendsClosedAt).toBeNull();
    });

    it('past the deadline and its margin, by the database’s clock: true', async () => {
      const order = await place();
      await wiring.orders.claimHoldSend(order, fromNow(-2 * HOUR));
      expect(await can(order)).toBe(true);
      expect((await row(order)).holdSendsClosedAt).not.toBeNull();
    });

    it('an order written with the column’s default, as an older build does: never', async () => {
      const order = await place();
      await owner.$executeRawUnsafe(
        `UPDATE "order" SET hold_send_claims = DEFAULT WHERE id = '${order.id}'`,
      );
      expect((await row(order)).holdSendClaims).toBe(1);
      expect(await can(order)).toBe(false);
      expect(await wiring.orders.claimHoldSend(order, fromNow(HOUR))).toEqual({
        holdNotAfter: null,
        claims: 2,
      });
    });

    it('a send with no deadline: never, however old', async () => {
      const order = await place();
      await write(order, { holdSendClaims: 1 });
      expect(await can(order)).toBe(false);
    });

    it('another organization’s name proves nothing', async () => {
      const order = await place();
      expect(await can({ ...order, organizationId: org.supplier })).toBe(false);
      expect((await row(order)).holdSendsClosedAt).toBeNull();
    });
  });

  it('the saga reads the fence, and the parties do not', async () => {
    const order = await place();
    const deadline = fromNow(HOUR);
    await wiring.orders.claimHoldSend(order, deadline);
    const view = await asActor({ organizationId: org.buyer }, () =>
      wiring.orders.sagaView(order.id),
    );
    expect(view).toMatchObject({
      holdNotAfter: deadline,
      holdSendsClosed: false,
      holdMayHaveSent: true,
    });
    const party = await asActor({ organizationId: org.buyer }, () => wiring.orders.get(order.id));
    expect(Object.keys(party).filter((field) => /hold/i.test(field))).toEqual([]);
  });

  describe('the database holds it forward, for any writer', () => {
    it('a deadline moved or cleared is refused', async () => {
      const order = await place();
      await wiring.orders.claimHoldSend(order, fromNow(HOUR));
      await expect(write(order, { holdNotAfter: fromNow(2 * HOUR) })).rejects.toThrow(
        /only moves forward/,
      );
      await expect(write(order, { holdNotAfter: null })).rejects.toThrow(/only moves forward/);
    });

    it('closed sends reopened, or a count lowered, is refused', async () => {
      const order = await place();
      await wiring.orders.claimHoldSend(order, fromNow(HOUR));
      await wiring.orders.closeHoldSendsOnRefusal(order);
      await expect(write(order, { holdSendsClosedAt: null })).rejects.toThrow(/only moves forward/);
      await expect(write(order, { holdSendClaims: 0 })).rejects.toThrow(/only moves forward/);
    });
  });

  describe('the migration', () => {
    class Undo extends Error {}

    /** The file's statements. A `;` inside a dollar-quoted body ends nothing. */
    function script(name: 'migration' | 'down'): string[] {
      const sql = readFileSync(
        join(__dirname, '../prisma/migrations', MIGRATION, `${name}.sql`),
        'utf8',
      ).replace(/^--.*$/gm, '');
      const quote = '$$';
      const statements = [''];
      sql.split(quote).forEach((part, index) => {
        if (index % 2 === 1) {
          statements[statements.length - 1] += quote + part + quote;
          return;
        }
        const [head = '', ...rest] = part.split(';');
        statements[statements.length - 1] += head;
        statements.push(...rest);
      });
      return statements.map((statement) => statement.trim()).filter(Boolean);
    }

    /** Runs in one transaction that never commits, with no other order carrying a deadline. */
    async function undone(body: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
      await owner
        .$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(
              `ALTER TABLE "order" DISABLE TRIGGER "trg_order_hold_fence_only_forward"`,
            );
            await tx.$executeRawUnsafe(`UPDATE "order" SET hold_not_after = NULL`);
            await tx.$executeRawUnsafe(
              `ALTER TABLE "order" ENABLE TRIGGER "trg_order_hold_fence_only_forward"`,
            );
            await body(tx);
            throw new Undo();
          },
          { timeout: 60_000 },
        )
        .catch((error: unknown) => {
          if (!(error instanceof Undo)) throw error;
        });
    }
    const apply = async (tx: Prisma.TransactionClient, name: 'migration' | 'down') => {
      for (const statement of script(name)) await tx.$executeRawUnsafe(statement);
    };
    const fence = (tx: Prisma.TransactionClient, id: string, status: string, deadline: string) =>
      tx.$executeRawUnsafe(
        `UPDATE "order" SET status = '${status}'::"OrderStatus", failure_reason = 'refused', hold_not_after = '${deadline}', hold_send_claims = 1 WHERE id = '${id}'`,
      );

    it.each(['PENDING', 'CANCELLING'])(
      'down refuses to forget the deadline of an order %s',
      async (status) => {
        const order = await place();
        await undone(async (tx) => {
          await fence(tx, order.id, status, fromNow(HOUR));
          await expect(apply(tx, 'down')).rejects.toThrow(/deadline still in use/);
        });
      },
    );

    it('down refuses even past the deadline, while the order has not ended', async () => {
      const order = await place();
      await undone(async (tx) => {
        await fence(tx, order.id, 'PENDING', fromNow(-48 * HOUR));
        await expect(apply(tx, 'down')).rejects.toThrow(/deadline still in use/);
      });
    });

    it('down refuses on a closed order a late hold can still reach', async () => {
      const order = await place();
      await undone(async (tx) => {
        await fence(tx, order.id, 'FAILED', fromNow(-HOUR / 2));
        await expect(apply(tx, 'down')).rejects.toThrow(/deadline still in use/);
      });
    });

    it('down passes once nothing depends on a deadline, and up marks what may have sent', async () => {
      const ended = await place();
      const open = await place();
      await undone(async (tx) => {
        await fence(tx, ended.id, 'FAILED', fromNow(-48 * HOUR));
        await apply(tx, 'down');
        const gone = await tx.$queryRawUnsafe<unknown[]>(
          `SELECT 1 FROM information_schema.columns WHERE table_name = 'order' AND column_name LIKE 'hold_%'`,
        );
        expect(gone).toEqual([]);
        await apply(tx, 'migration');
        const [after] = await tx.$queryRawUnsafe<{ claims: number; deadline: Date | null }[]>(
          `SELECT hold_send_claims AS claims, hold_not_after AS deadline FROM "order" WHERE id = '${open.id}'`,
        );
        // Whatever it had said: nothing records what this order sent while the column was gone.
        expect(after).toEqual({ claims: 1, deadline: null });
      });
    });
  });
});
