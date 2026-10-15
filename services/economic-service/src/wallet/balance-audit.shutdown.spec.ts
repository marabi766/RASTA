import { LedgerBalanceAudit } from './balance-audit';

/**
 * Codex on #277 (finding 3): `onApplicationShutdown` only cleared the timer, so a
 * pass in flight kept paging the wallets (each page bounded by 30 s + 120 s of
 * transaction) during teardown. The audit is now one of `OutboxShutdown`'s
 * workers: no page begins after a stop, the stop waits only until the shared
 * deadline, and a pass cut short publishes no gauge.
 */
function setup(pages: Array<Promise<unknown[]>>) {
  const pageForAudit = jest.fn((_skip: number) => pages.shift() ?? Promise.resolve([]));
  const wallets = {
    client: {
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $executeRawUnsafe: jest.fn(async () => 0) }),
      ),
    },
    pageForAudit,
    findEscrowAccount: jest.fn(async () => null),
    activeHoldTotal: jest.fn(async () => 0n),
  };
  const ledger = { balanceOf: jest.fn(async () => 0n) };
  const env = {
    ECONOMIC_BALANCE_AUDIT_ENABLED: true,
    ECONOMIC_BALANCE_AUDIT_INTERVAL_SECONDS: 3600,
    ECONOMIC_BALANCE_AUDIT_BATCH_SIZE: 2,
  };
  const audit = new LedgerBalanceAudit(wallets as never, ledger as never, env as never);
  return { audit, wallets };
}

const wallet = (id: string) => ({
  id,
  organizationId: 'org',
  currency: 'IRR',
  ledgerAccountId: `acc-${id}`,
  ledgerBalanceMinor: 0n,
  pendingBalanceMinor: 0n,
  availableBalanceMinor: 0n,
});

describe('LedgerBalanceAudit shutdown (Codex on #277, finding 3)', () => {
  it('starts no further page once stopped', async () => {
    let releaseFirst!: (rows: unknown[]) => void;
    const first = new Promise<unknown[]>((resolve) => (releaseFirst = resolve));
    // Page one is full, so without the check a second page would be read.
    const { audit, wallets } = setup([first, Promise.resolve([wallet('c')])]);

    const running = audit.run();
    await new Promise((resolve) => setImmediate(resolve));
    const stopped = audit.stop({ deadlineAt: Date.now() + 5_000 });
    releaseFirst([wallet('a'), wallet('b')]);
    await stopped;
    await running;
    await new Promise((resolve) => setTimeout(resolve, 20)); // room for a page that should not begin

    expect(wallets.pageForAudit).toHaveBeenCalledTimes(1);
    expect(wallets.client.$transaction).toHaveBeenCalledTimes(1);
  });

  it('writes no gauge for a pass it cut short', async () => {
    const { walletsOpenTotal, walletLedgerDeviationsTotal } =
      await import('../observability/metrics');
    const open = jest.spyOn(walletsOpenTotal, 'set');
    const deviations = jest.spyOn(walletLedgerDeviationsTotal, 'set');
    let releaseFirst!: (rows: unknown[]) => void;
    const first = new Promise<unknown[]>((resolve) => (releaseFirst = resolve));
    const { audit } = setup([first]);

    const running = audit.run();
    await new Promise((resolve) => setImmediate(resolve));
    const stopped = audit.stop({ deadlineAt: Date.now() + 5_000 });
    releaseFirst([wallet('a'), wallet('b')]);
    await Promise.all([stopped, running]);

    expect(open).not.toHaveBeenCalled();
    expect(deviations).not.toHaveBeenCalled();
  });

  it('returns at the shared deadline when a page does not finish', async () => {
    const { audit } = setup([new Promise<unknown[]>(() => undefined)]);

    void audit.run();
    await new Promise((resolve) => setImmediate(resolve));
    const started = Date.now();
    await audit.stop({ deadlineAt: started + 80 });

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('is one stop, and run() does nothing afterwards', async () => {
    const { audit, wallets } = setup([]);
    const first = audit.stop();
    expect(audit.onApplicationShutdown()).toBe(first);
    await first;

    await expect(audit.run()).resolves.toEqual([]);
    expect(wallets.pageForAudit).not.toHaveBeenCalled();
  });
});
