import { runUnscoped } from '@rasta/nest-common';
import {
  asActor,
  cleanup,
  fundWallet,
  newPrisma,
  readBalances,
  tenants,
  wire,
  type Wiring,
} from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * The concurrency scenario docs/10 § 10.5 and § 10.12 make mandatory:
 *
 * > تست همزمانی اجباری: ۱۰۰ برداشت موازی از یک کیف پول → دقیقاً به تعداد
 * > موجودی موفق.
 * >
 * > ۱۰۰ برداشت موازی → دقیقاً به تعداد موجودی موفق؛ هرگز مانده منفی
 *
 * This is the suite no single-threaded test can replace. The maintenance phase
 * learned it the expensive way: ten concurrent cost entries broke an
 * "increment the total" implementation that every unit test passed
 * (`PROJECT_MEMORY` § 7-ب). The same class of defect in a wallet is money
 * spent twice.
 *
 * Two mechanisms are under test and they protect different things:
 *
 *   the row lock          `SELECT … FOR UPDATE` in ascending id order, so two
 *                         holds cannot both read the same available balance
 *   `ck_wallet_balances`  the database refusing a negative available balance,
 *                         so an overspend fails even if the lock were wrong
 */
describe('wallet concurrency (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  /** One hold attempt, reported as a settled outcome rather than a rejection. */
  function attemptHold(organizationId: string, amountMinor: string, index: number) {
    return asActor({ organizationId }, () =>
      wiring.transactions.create({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: org.b,
        grossAmountMinor: amountMinor,
        currency: 'IRR',
        holdFunds: true,
        sourceType: 'ITEST',
        sourceReference: `parallel-${index}`,
      }),
    ).then(
      () => 'ok' as const,
      (error: { code?: string }) => (error?.code ?? 'UNKNOWN') as string,
    );
  }

  it('lets exactly as many parallel withdrawals succeed as the balance covers', async () => {
    // The documented scenario, to the letter: a wallet holding 10 units of
    // 1 000 000 rial, and 100 simultaneous attempts to take one unit each.
    const organizationId = `${org.a}-PARALLEL`;
    const unit = 1_000_000n;
    const affordable = 10;

    await fundWallet(wiring, organizationId, unit * BigInt(affordable));

    const outcomes = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        attemptHold(organizationId, unit.toString(), index),
      ),
    );

    const succeeded = outcomes.filter((outcome) => outcome === 'ok').length;
    const refused = outcomes.filter((outcome) => outcome === 'INSUFFICIENT_BALANCE').length;

    expect(succeeded).toBe(affordable);
    expect(succeeded + refused).toBe(100);

    const balances = await readBalances(prisma, await walletId(organizationId));
    expect(balances.available).toBe(0n);
    expect(balances.pending).toBe(unit * BigInt(affordable));
    expect(balances.ledger).toBe(unit * BigInt(affordable));

    await cleanup(prisma, [organizationId]);
  });

  it('never lets a balance go negative, at any concurrency', async () => {
    // The invariant `ck_wallet_balances` enforces. If the lock were ever taken
    // wrongly the write would fail here rather than leaving a wallet owing
    // money it never had.
    const organizationId = `${org.a}-NEGATIVE`;
    await fundWallet(wiring, organizationId, 5n);

    await Promise.all(
      Array.from({ length: 40 }, (_, index) => attemptHold(organizationId, '1', index)),
    );

    const balances = await readBalances(prisma, await walletId(organizationId));
    expect(balances.available).toBeGreaterThanOrEqual(0n);
    expect(balances.pending).toBeGreaterThanOrEqual(0n);
    expect(balances.available).toBe(balances.ledger - balances.pending);

    await cleanup(prisma, [organizationId]);
  });

  it('keeps the wallet in step with the ledger after the storm', async () => {
    // The property recomputation buys (ADR-034): the stored balance is a
    // function of the ledger, so no amount of concurrency can make the two
    // disagree — which an "increment the balance" implementation could not
    // promise.
    const organizationId = `${org.a}-LEDGER`;
    await fundWallet(wiring, organizationId, 7_000_000n);

    await Promise.all(
      Array.from({ length: 30 }, (_, index) => attemptHold(organizationId, '1000000', index)),
    );

    const id = await walletId(organizationId);
    const stored = await readBalances(prisma, id);

    const derived = await runUnscoped(
      'the concurrency audit recomputes from the ledger',
      () =>
        prisma.client.$queryRaw<{ wallet: bigint; escrow: bigint }[]>`
        SELECT
          COALESCE(SUM(CASE WHEN a.purpose = 'WALLET' THEN s.balance ELSE 0 END), 0) AS wallet,
          COALESCE(SUM(CASE WHEN a.purpose = 'ESCROW' THEN s.balance ELSE 0 END), 0) AS escrow
        FROM ledger_account a
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount_minor
                                   ELSE -e.amount_minor END), 0) AS balance
            FROM ledger_entry e WHERE e.account_id = a.id
        ) s ON TRUE
        WHERE a.organization_id = ${organizationId}
          AND a.currency = 'IRR'
          AND a.purpose IN ('WALLET', 'ESCROW')
      `,
    );

    expect(stored.available).toBe(BigInt(derived[0]!.wallet));
    expect(stored.pending).toBe(BigInt(derived[0]!.escrow));

    await cleanup(prisma, [organizationId]);
  });

  it('settles two opposite transactions between the same pair without deadlocking', async () => {
    // The deadlock the ascending-id lock order makes structurally impossible
    // (ADR-031). Without it, A→B locking "mine first" and B→A doing the same
    // would each hold what the other needs.
    const left = `${org.a}-PAIR-L`;
    const right = `${org.b}-PAIR-R`;

    await fundWallet(wiring, left, 5_000_000n);
    await fundWallet(wiring, right, 5_000_000n);

    async function settleOneWay(payer: string, payee: string, amount: string) {
      const transaction = await asActor({ organizationId: payer }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: payee,
          grossAmountMinor: amount,
          currency: 'IRR',
          holdFunds: true,
        }),
      );
      await asActor({ organizationId: payer }, () =>
        wiring.transactions.authoriseSettlement(transaction.id),
      );
      return asActor({ organizationId: payer }, () =>
        wiring.settlements.settle(transaction.id, 'USR-ITEST'),
      );
    }

    // Ten pairs in flight at once, in both directions.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        index % 2 === 0 ? settleOneWay(left, right, '100000') : settleOneWay(right, left, '100000'),
      ),
    );

    expect(results).toHaveLength(10);
    for (const result of results) {
      expect(result.settlementId).toBeTruthy();
    }

    // And value is conserved: what left one side arrived at the other, less
    // whatever commission the platform recognised. Stated with the commission
    // term rather than assuming zero, so the assertion stays true whatever the
    // configured rate happens to be.
    const commission = results.reduce((total, result) => total + result.commissionAmountMinor, 0n);
    const leftBalance = await readBalances(prisma, await walletId(left));
    const rightBalance = await readBalances(prisma, await walletId(right));
    expect(leftBalance.ledger + rightBalance.ledger + commission).toBe(10_000_000n);

    await cleanup(prisma, [left, right]);
  });

  it('places exactly one hold when the same request arrives twice at once', async () => {
    // `uq_wallet_hold_active_reference`. Both retries pass the application
    // pre-flight; exactly one survives the insert.
    const organizationId = `${org.c}-RETRY`;
    await fundWallet(wiring, organizationId, 1_000_000n);

    const transaction = await asActor({ organizationId }, () =>
      wiring.transactions.create({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: org.b,
        grossAmountMinor: '400000',
        currency: 'IRR',
        holdFunds: false,
      }),
    );

    const wallet = await walletId(organizationId);

    const place = () =>
      asActor({ organizationId }, () =>
        prisma.transaction(async (tx) => {
          const [locked] = await wiring.walletRepository.lock(tx, [wallet]);
          if (!locked) throw new Error('wallet vanished');
          return wiring.wallets.placeHold(tx, {
            wallet: locked,
            amountMinor: 400_000n,
            reference: transaction.id,
            referenceType: 'TRANSACTION',
            transactionId: transaction.id,
            placedBy: 'itest',
          });
        }),
      ).then(
        (result) => ({ ok: true as const, result }),
        () => ({ ok: false as const }),
      );

    await Promise.all([place(), place(), place(), place()]);

    const holds = await runUnscoped('the retry audit counts holds on one wallet', () =>
      prisma.client.walletHold.findMany({ where: { walletId: wallet, reference: transaction.id } }),
    );

    const active = holds.filter((hold) => hold.status === 'ACTIVE');
    expect(active).toHaveLength(1);

    // And the money was only taken once.
    const balances = await readBalances(prisma, wallet);
    expect(balances.pending).toBe(400_000n);
    expect(balances.available).toBe(600_000n);

    await cleanup(prisma, [organizationId]);
  });

  async function walletId(organizationId: string): Promise<string> {
    const wallet = await runUnscoped('the concurrency audit reads the wallet under test', () =>
      prisma.client.wallet.findUnique({
        where: { organizationId_currency: { organizationId, currency: 'IRR' } },
      }),
    );
    if (!wallet) throw new Error(`no wallet for ${organizationId}`);
    return wallet.id;
  }
});
