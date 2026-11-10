import { ZONE_SWITCHES, inSessionZone } from '@rasta/testing';
import { withUtcSession } from '@rasta/config';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PaymentService } from '../src/payment/payment.service';
import { PaymentReconciliationRepository } from '../src/payment/payment-reconciliation.repository';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import { WalletRepository } from '../src/wallet/wallet.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, newPrisma, tenants, testEnv, wire, type Wiring } from './helpers';

/**
 * The reconciler's lease and backoff decide when money is looked at again, so they do
 * not depend on the session's zone, and neither does a replica in another zone
 * (FU-188). Bare `now()` here wrote the session's wall time into `timestamp(3)`.
 */
describe('payment_reconciliation_task deadlines in any session zone (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let payments: PaymentService;
  const org = tenants();
  const task = `payment_reconciliation_task WHERE payment_intent_id = $1`;

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
    payments = new PaymentService(
      prisma,
      wiring.ledger,
      wiring.wallets,
      wiring.walletRepository,
      new MockPaymentProvider(),
      wiring.paymentReconciliation,
      testEnv(),
    );
  });
  afterAll(async () => {
    await cleanup(prisma, [org.a]);
    await prisma.stop();
  });

  const intent = async (): Promise<string> => {
    const wallet = await asActor({ organizationId: org.a }, () => wiring.wallets.getOrOpen('IRR'));
    const paid = await asActor({ organizationId: org.a }, () =>
      payments.topUp(wallet.id, { amountMinor: '1000', idempotencyKey: `TZ-${ulid()}` }),
    );
    return paid.paymentIntentId;
  };

  it.each(ZONE_SWITCHES)('a task written in %s and read in %s', async (first, second) => {
    const paymentIntentId = await intent();
    await inSessionZone(prisma, async ({ db, tx, zone, secondsFromNow }) => {
      const repository = new PaymentReconciliationRepository(db, testEnv());
      const target = { organizationId: org.a, paymentIntentId };
      const ids = <T extends { paymentIntentId: string }>(rows: T[]) =>
        rows.filter((row) => row.paymentIntentId === paymentIntentId);
      // ISOLATION-ALLOW-UNBOUNDED: inside a transaction that inSessionZone always rolls back.
      await runUnscoped('the suite clears its own transaction of other tasks', () =>
        tx.$executeRawUnsafe("DELETE FROM payment_reconciliation_task WHERE status <> 'DONE'"),
      );

      await zone(first);
      await asActor({ organizationId: org.a }, () =>
        repository.open(tx as never, { ...target, kind: 'REFUND', due: 'NOW', outcome: 'TEST' }),
      );
      expect(await secondsFromNow('next_attempt_at', task, paymentIntentId)).toBe(0);
      expect(await secondsFromNow('created_at', task, paymentIntentId)).toBeCloseTo(0, 2);

      // Due at once, in both zones, and leased for exactly what was asked.
      const [claimed] = ids(await repository.claimDue(1000, 60, 'TOKEN_A'));
      expect(claimed).toBeDefined();
      expect(await secondsFromNow('lease_until', task, paymentIntentId)).toBe(60);

      // Mid-lease, in the other zone: still leased, for everybody.
      await zone(second);
      expect(ids(await repository.claimDue(1000, 60, 'TOKEN_B'))).toEqual([]);
      const open = await repository.lockOpenTask(tx as never, org.a, paymentIntentId);
      expect(open?.leased).toBe(true);
      expect(
        await repository.requeue(tx as never, { id: claimed!.id, organizationId: org.a }),
      ).toBe(0);

      // Parked for exactly the backoff, and not due in the other zone.
      await zone(first);
      expect(await repository.retryLater(claimed!, 'TEST', 300, true)).toBe(1);
      expect(await secondsFromNow('next_attempt_at', task, paymentIntentId)).toBe(300);
      await zone(second);
      expect(ids(await repository.claimDue(1000, 60, 'TOKEN_B'))).toEqual([]);
      expect((await repository.backlog()).oldestDueAgeSeconds).toBe(0);

      // Requeued in one zone: due now in the other, and a lapsed lease is taken back.
      expect(
        await repository.requeue(tx as never, { id: claimed!.id, organizationId: org.a }),
      ).toBe(1);
      await zone(first);
      const [lapsed] = ids(await repository.claimDue(1000, -60, 'TOKEN_C'));
      expect(lapsed).toBeDefined();
      await zone(second);
      const [retaken] = ids(await repository.claimDue(1000, 60, 'TOKEN_D'));
      expect(retaken?.leaseToken).toBe('TOKEN_D');

      // The backlog gauge reads the wait, not the wait plus an offset.
      await zone(first);
      expect(await repository.retryLater(retaken!, 'TEST', -100, true)).toBe(1);
      await zone(second);
      expect((await repository.backlog()).oldestDueAgeSeconds).toBeCloseTo(100, 2);

      // The closing stamps.
      await zone(first);
      expect(
        await repository.close(tx as never, { ...target, resolution: 'REFUNDED', resolvedBy: 'B' }),
      ).toBe(1);
      expect(await secondsFromNow('done_at', task, paymentIntentId)).toBeCloseTo(0, 2);
      expect(await secondsFromNow('updated_at', task, paymentIntentId)).toBeCloseTo(0, 2);
    });
  });

  it.each(ZONE_SWITCHES)('the sweeper and the operator, %s then %s', async (first, second) => {
    const [fenced, escalated, operated] = [await intent(), await intent(), await intent()];
    await inSessionZone(prisma, async ({ db, tx, zone, secondsFromNow }) => {
      const repository = new PaymentReconciliationRepository(db, testEnv());
      const open = (paymentIntentId: string) =>
        asActor({ organizationId: org.a }, () =>
          repository.open(tx as never, {
            organizationId: org.a,
            paymentIntentId,
            kind: 'REFUND',
            due: 'NOW',
            outcome: 'TEST',
          }),
        );
      const row = task;
      // ISOLATION-ALLOW-UNBOUNDED: inside a transaction that inSessionZone always rolls back.
      await runUnscoped('the suite clears its own transaction of other tasks', () =>
        tx.$executeRawUnsafe("DELETE FROM payment_reconciliation_task WHERE status <> 'DONE'"),
      );
      await zone(first);
      await Promise.all([open(fenced), open(escalated), open(operated)]);
      const claimed = await repository.claimDue(1000, 60, 'TOKEN');
      const of = (paymentIntentId: string) =>
        claimed.find((one) => one.paymentIntentId === paymentIntentId)!;

      // The operator is refused mid-lease, in the other zone, and admitted once it ended.
      await zone(second);
      const operator = repository.operatorOwnershipOf({
        id: of(operated).id,
        organizationId: org.a,
      });
      expect(await operator.verify(tx as never)).toBe(false);
      expect(await operator.finish(tx as never, 'REFUNDED', 'B')).toBe(0);
      expect(await repository.retryLater(of(operated), 'TEST', 300, true)).toBe(1);
      expect(await operator.verify(tx as never)).toBe(true);
      await zone(first);
      expect(await operator.finish(tx as never, 'REFUNDED', 'B')).toBe(1);
      expect(await secondsFromNow('done_at', row, operated)).toBeCloseTo(0, 2);

      // The sweeper's fenced writes stamp UTC wall time.
      expect(await repository.ownershipOf(of(fenced)).finish(tx as never, 'REFUNDED', 'B')).toBe(1);
      expect(await secondsFromNow('done_at', row, fenced)).toBeCloseTo(0, 2);
      await zone(second);
      expect(await repository.ownershipOf(of(escalated)).escalate(tx as never, 'O', true)).toBe(1);
      expect(await secondsFromNow('escalated_at', row, escalated)).toBeCloseTo(0, 2);
    });
  });

  it.each(ZONE_SWITCHES)('the wallet stamp written in %s', async (zoneName) => {
    const wallet = await asActor({ organizationId: org.a }, () => wiring.wallets.getOrOpen('IRR'));
    await inSessionZone(prisma, async ({ db, tx, zone, secondsFromNow }) => {
      await zone(zoneName);
      await new WalletRepository(db).recomputeFromLedger(tx as never, {
        id: wallet.id,
        organizationId: org.a,
        currency: 'IRR',
      });
      expect(await secondsFromNow('updated_at', 'wallet WHERE id = $1', wallet.id)).toBeCloseTo(
        0,
        2,
      );
    });
  });

  it.each(ZONE_SWITCHES)('the ledger stamps written in %s', async (zoneName) => {
    await inSessionZone(prisma, async ({ tx, zone, secondsFromNow }) => {
      await zone(zoneName);
      const organizationId = org.a;
      const userId = `U_${ulid()}`;
      // Private, and it writes only through the transaction it is given.
      const rewards = wiring.rewards as unknown as {
        ensureBalanceRow(client: unknown, organization: string, user: string): Promise<unknown>;
      };
      await runUnscoped('the suite stamps its own balance', () =>
        rewards.ensureBalanceRow(tx, organizationId, userId),
      );
      expect(
        await secondsFromNow('updated_at', 'reward_balance WHERE user_id = $1', userId),
      ).toBeCloseTo(0, 2);
    });
  });

  // The trigger fires on every write of "transaction"; a table of its own keeps a transaction
  // and its guards out of this. As the owner, who may create it, and rolled back.
  it.each(['Asia/Tehran', 'America/Los_Angeles', 'UTC'])(
    'stamp_transaction_held_at stamps UTC wall time in %s',
    async (name) => {
      const url = process.env.DATABASE_URL_ECONOMIC_MIGRATOR;
      if (!url) throw new Error('DATABASE_URL_ECONOMIC_MIGRATOR is required');
      const owner = new PrismaService(withUtcSession(url));
      try {
        await inSessionZone(owner, async ({ tx, zone, secondsFromNow }) => {
          await tx.$executeRawUnsafe(
            'CREATE TEMP TABLE held_probe (id text, status text, held_at timestamp(3)) ON COMMIT DROP',
          );
          await tx.$executeRawUnsafe(
            `CREATE TRIGGER held_probe_stamp BEFORE INSERT OR UPDATE ON held_probe
               FOR EACH ROW EXECUTE FUNCTION stamp_transaction_held_at()`,
          );
          await zone(name);
          await tx.$executeRawUnsafe(`INSERT INTO held_probe (id, status) VALUES ('p', 'HELD')`);
          const at = await secondsFromNow('held_at', 'held_probe WHERE id = $1', 'p');
          expect(Math.abs(at)).toBeLessThan(0.002);
        });
      } finally {
        await owner.stop();
      }
    },
  );

  // Written from their DEFAULT by decide_transaction_hold() and
  // quarantine_transaction_source(): the DEFAULT itself must not read the session's zone.
  it.each([
    ['transaction_hold_decision', 'decided_at'],
    ['transaction_source_quarantine', 'quarantined_at'],
  ])('%s.%s defaults to UTC wall time in any zone', async (table, column) => {
    await inSessionZone(prisma, async ({ tx, zone }) => {
      const [{ expression } = { expression: '' }] = await tx.$queryRawUnsafe<
        { expression: string }[]
      >(
        `SELECT pg_get_expr(d.adbin, d.adrelid) AS expression
           FROM pg_attrdef d
           JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
          WHERE d.adrelid = $1::regclass AND a.attname = $2`,
        table,
        column,
      );
      for (const name of ['Asia/Tehran', 'America/Los_Angeles', 'UTC']) {
        await zone(name);
        const [row] = await tx.$queryRawUnsafe<{ off: number }[]>(
          `SELECT EXTRACT(EPOCH FROM (${expression})::timestamp(3)
             - (now() AT TIME ZONE 'UTC'))::float8 AS off`,
        );
        expect(Math.abs(row!.off)).toBeLessThan(0.002);
      }
    });
  });
});
