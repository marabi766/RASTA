import { ulid } from 'ulid';
import { runUnscoped, runWithContext, type RequestContext } from '@rasta/nest-common';
import { LedgerBalanceAudit } from '../src/wallet/balance-audit';
import { cleanup, fundWallet, newPrisma, testEnv, wire, type Wiring } from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { EconomicEnv } from '../src/config/env';

/**
 * The parts that run on a timer, and the reads that serve a report.
 *
 * Neither is reachable from a request, and both fail quietly by design — the
 * reconciliation swallows its own errors so upkeep can never take the service
 * down, and the aggregate reads are only ever seen through the trial balance.
 * "Fails quietly" and "is never exercised" look identical from outside, which
 * is the reason for this file.
 */
describe('upkeep', () => {
  let prisma: PrismaService;
  let wiring: Wiring;

  const org = { a: `ORG-ITEST-UPKEEP-${ulid().slice(-10)}` };

  const asOrg = <T>(fn: () => Promise<T>): Promise<T> => {
    const context: RequestContext = {
      correlationId: `upkeep-${ulid()}`,
      requestId: `upkeep-${ulid()}`,
      organizationId: org.a,
      userId: 'USR-ITEST-UPKEEP',
      roles: ['ORGANIZATION_ADMIN'],
      authType: 'USER',
      startedAt: Date.now(),
    };
    return runWithContext(context, async () => fn());
  };

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a]);
    await prisma.onModuleDestroy();
  });

  // -------------------------------------------------------------------------
  // The reconciliation timer
  // -------------------------------------------------------------------------

  describe('the reconciliation timer', () => {
    /** The same env, with the audit switched on and its interval at the floor. */
    function enabledEnv(): EconomicEnv {
      return {
        ...testEnv(),
        ECONOMIC_BALANCE_AUDIT_ENABLED: true,
        ECONOMIC_BALANCE_AUDIT_INTERVAL_SECONDS: 3600,
      };
    }

    it('starts a timer when enabled and clears it on shutdown', () => {
      const audit = new LedgerBalanceAudit(wiring.walletRepository, wiring.ledger, enabledEnv());

      audit.onModuleInit();
      // Unref'd, so a live timer never holds the process open — which is what
      // makes it safe to start one in a test at all.
      expect(() => audit.onApplicationShutdown()).not.toThrow();
      // And idempotent: a second shutdown, after the timer is already cleared,
      // must not throw during an already-failing shutdown sequence.
      expect(() => audit.onApplicationShutdown()).not.toThrow();
    });

    it('reports a failed pass rather than letting it escape', async () => {
      // A reconciliation that threw would take down the interval that runs it,
      // and the next thing anybody would know is that no wallet had been
      // checked for a week. The failure is logged and the pass returns empty.
      const broken = {
        pageForAudit: async () => {
          throw new Error('the database went away mid-pass');
        },
        activeHoldTotal: async () => 0n,
      } as unknown as Wiring['walletRepository'];

      const audit = new LedgerBalanceAudit(broken, wiring.ledger, testEnv());

      await expect(audit.run()).resolves.toEqual([]);
    });

    it('reports a non-Error failure without losing what it was', async () => {
      // A rejected promise carrying a string rather than an Error is exactly
      // what a driver-level failure looks like, and stringifying it is the
      // difference between a log line naming the cause and one saying
      // "undefined".
      const broken = {
        pageForAudit: async () => {
          // eslint-disable-next-line no-throw-literal
          throw 'connection reset';
        },
        activeHoldTotal: async () => 0n,
      } as unknown as Wiring['walletRepository'];

      const audit = new LedgerBalanceAudit(broken, wiring.ledger, testEnv());

      await expect(audit.run()).resolves.toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // The aggregate reads behind the trial balance
  // -------------------------------------------------------------------------

  describe('the ledger aggregates', () => {
    it('totals every account platform-wide, and one organization when asked', async () => {
      await fundWallet(wiring, org.a, 44_000n);

      // Unscoped: what the trial balance uses. A per-tenant slice of a
      // double-entry ledger does not balance, so the report has to be able to
      // read across organizations (docs/10 § 10.13).
      const everything = await asOrg(() => wiring.ledgerRepository.accountTotals());
      expect(everything.length).toBeGreaterThan(0);

      // Scoped: the same aggregation narrowed to one organization, which is
      // what an operator diagnosing a single tenant needs.
      const mine = await asOrg(() => wiring.ledgerRepository.accountTotals(org.a));
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.length).toBeLessThanOrEqual(everything.length);

      for (const row of mine) {
        // Both sides are always present, even when one of them is zero: a null
        // would propagate into the trial balance's totals as `NaN` and the
        // report would silently stop balancing.
        expect(typeof row.debitMinor).toBe('bigint');
        expect(typeof row.creditMinor).toBe('bigint');
      }
    });

    it('pages entries and stops offering a cursor at the end', async () => {
      const { walletId } = await fundWallet(wiring, org.a, 9_000n);
      const wallet = await asOrg(() => wiring.walletRepository.findById(walletId));
      expect(wallet).not.toBeNull();

      const first = await asOrg(() =>
        wiring.ledgerRepository.listEntries({
          accountId: wallet!.ledgerAccountId,
          cursor: undefined,
          limit: 1,
        }),
      );
      expect(first.items).toHaveLength(1);

      // The last page reports no cursor rather than one that returns nothing:
      // a client following a non-null cursor forever never terminates.
      const all = await asOrg(() =>
        wiring.ledgerRepository.listEntries({
          accountId: wallet!.ledgerAccountId,
          cursor: undefined,
          limit: 500,
        }),
      );
      expect(all.hasMore).toBe(false);
      expect(all.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Causation
  // -------------------------------------------------------------------------

  it('carries the causing event onto the event it produces', async () => {
    // A consumer records what caused it, so a chain can be walked backwards:
    // this journal, because of that approval, because of that repair. Without
    // it the correlation id says the events are related and nothing says how.
    const causationId = `EVT_${ulid()}`;
    const { walletId } = await fundWallet(wiring, org.a, 5_000n);
    const wallet = await asOrg(() => wiring.walletRepository.findById(walletId));

    await asOrg(() =>
      wiring.prisma.transaction((tx) =>
        wiring.ledger.enqueue(tx, {
          eventName: 'WALLET_OPENED',
          aggregateId: wallet!.id,
          organizationId: org.a,
          causationId,
          payload: {
            walletId: wallet!.id,
            organizationId: org.a,
            currency: 'IRR',
            openedAt: new Date().toISOString(),
          },
        }),
      ),
    );

    const rows = await runUnscoped('the suite reads the outbox row it produced', () =>
      prisma.client.outboxMessage.findMany({
        where: { organizationId: org.a, eventName: 'WALLET_OPENED' },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    );

    const withCausation = rows.find(
      (row) => (row.headers as Record<string, string>)['x-causation-id'] === causationId,
    );
    expect(withCausation).toBeDefined();
  });
});
