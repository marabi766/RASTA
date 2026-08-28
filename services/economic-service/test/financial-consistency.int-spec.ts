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
import { naturalBalance } from '../src/ledger/accounts';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * The financial-consistency suite docs/10 § 10.12 makes a merge gate.
 *
 * Each block below is one row of that table, exercised through the real code
 * path against a real PostgreSQL:
 *
 *   توازن Journal              every journal balances, per currency
 *   صحت Reversal               a reversal restores the exact prior balance
 *   تطابق کیف پول و دفتر کل    wallet balances equal the ledger, always
 *   ترتیب تسویه                settlement without authorisation is impossible
 *   توقف با اعتراض             a dispute stops every automatic movement
 *
 * The hold, settlement and refund flows are asserted end to end rather than in
 * pieces, because the property that matters is that the *whole* movement
 * balances — a suite that checked each journal in isolation would miss a
 * settlement that credited the payee twice.
 */
describe('financial consistency (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();

  /**
   * When this suite began.
   *
   * The balance audit below is scoped to journals posted since then. Scanning
   * the entire table sounds stronger and is actually weaker: it makes the
   * assertion depend on whatever a developer's local stack happens to contain,
   * so a real regression and a leftover row from last week's demo look
   * identical. Every journal this suite created is the claim being made.
   */
  let suiteStartedAt: Date;

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
    suiteStartedAt = new Date();
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  /** Every journal in the database, checked for balance per currency. */
  async function everyJournalBalances(): Promise<{ journalId: string; delta: string }[]> {
    return runUnscoped(
      'the consistency audit spans every tenant by design',
      () =>
        prisma.client.$queryRaw<{ journalId: string; delta: string }[]>`
        SELECT journal_id AS "journalId",
               SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END)::text
                 AS delta
          FROM ledger_entry
         WHERE posted_at >= ${suiteStartedAt}
         GROUP BY journal_id, currency
        HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0
      `,
    );
  }

  /** The natural balance of one organization's account of a given purpose. */
  async function accountBalance(organizationId: string, purpose: 'WALLET' | 'ESCROW') {
    const rows = await runUnscoped(
      'the consistency audit reads both counterparties',
      () =>
        prisma.client.$queryRaw<{ type: string; debit: bigint; credit: bigint }[]>`
        SELECT a.account_type AS type,
               COALESCE(SUM(CASE WHEN e.direction = 'DEBIT'  THEN e.amount_minor ELSE 0 END), 0) AS debit,
               COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount_minor ELSE 0 END), 0) AS credit
          FROM ledger_account a
          LEFT JOIN ledger_entry e ON e.account_id = a.id
         WHERE a.organization_id = ${organizationId}
           AND a.purpose = ${purpose}::"AccountPurpose"
           AND a.currency = 'IRR'
         GROUP BY a.account_type
      `,
    );
    const row = rows[0];
    if (!row) return 0n;
    return naturalBalance(row.type as 'LIABILITY', BigInt(row.debit), BigInt(row.credit));
  }

  describe('the whole order cycle balances', () => {
    it('holds, settles and leaves every journal balanced', async () => {
      await fundWallet(wiring, org.a, 10_000_000n);

      const transaction = await asActor({ organizationId: org.a }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '10000000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );

      // Held: the money has left the spendable balance and sits in escrow —
      // which is a real ledger account, not an annotation (ADR-034).
      const held = await readBalances(prisma, (await walletOf(org.a)).id);
      expect(held.available).toBe(0n);
      expect(held.pending).toBe(10_000_000n);
      expect(held.ledger).toBe(10_000_000n);

      await asActor({ organizationId: org.a }, () =>
        wiring.transactions.authoriseSettlement(transaction.id),
      );
      const settlement = await asActor({ organizationId: org.a }, () =>
        wiring.settlements.settle(transaction.id, 'USR-ITEST'),
      );

      // With no commission rule configured — the MVP's real state — the payee
      // receives the whole amount and the platform earns nothing (ADR-023).
      expect(settlement.commissionMatched).toBe(false);
      expect(settlement.commissionAmountMinor).toBe(0n);
      expect(settlement.netAmountMinor).toBe(10_000_000n);

      const payer = await readBalances(prisma, (await walletOf(org.a)).id);
      const payee = await readBalances(prisma, (await walletOf(org.b)).id);

      expect(payer).toEqual({ available: 0n, pending: 0n, ledger: 0n });
      expect(payee).toEqual({ available: 10_000_000n, pending: 0n, ledger: 10_000_000n });

      expect(await everyJournalBalances()).toEqual([]);
    });

    it('charges commission at the rate in force, and still balances', async () => {
      // 250bp of 4,000,000 is 100,000. The payee receives 3,900,000 and the
      // platform recognises 100,000 of revenue — in one journal.
      await asActor({ organizationId: org.a }, () =>
        wiring.commissions.createRule({
          // Scoped to the payee rather than platform-wide. Both because it is
          // the realistic shape of a negotiated rate, and because a global rule
          // left behind by one suite silently reprices every settlement in the
          // next — which is exactly how this test first failed.
          organizationId: org.b,
          transactionType: 'MARKETPLACE_ORDER',
          rateBasisPoints: 250,
          status: 'ACTIVE',
          label: 'itest',
        }),
      );

      await fundWallet(wiring, org.a, 4_000_000n);

      const transaction = await asActor({ organizationId: org.a }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '4000000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );
      await asActor({ organizationId: org.a }, () =>
        wiring.transactions.authoriseSettlement(transaction.id),
      );
      const settlement = await asActor({ organizationId: org.a }, () =>
        wiring.settlements.settle(transaction.id, 'USR-ITEST'),
      );

      expect(settlement.commissionMatched).toBe(true);
      expect(settlement.commissionAmountMinor).toBe(100_000n);
      expect(settlement.netAmountMinor).toBe(3_900_000n);

      expect(await everyJournalBalances()).toEqual([]);
    });
  });

  describe('wallet and ledger agree, always', () => {
    it('matches every stored balance against the accounts behind it', async () => {
      // docs/10 § 10.12: `wallet.ledgerBalance = Σ(ledger_entry)` for every
      // wallet. Under ADR-034 that decomposes into available = the wallet
      // account and pending = the escrow account.
      for (const organizationId of [org.a, org.b]) {
        const wallet = await walletOf(organizationId);
        const stored = await readBalances(prisma, wallet.id);

        expect(stored.available).toBe(await accountBalance(organizationId, 'WALLET'));
        expect(stored.pending).toBe(await accountBalance(organizationId, 'ESCROW'));
        expect(stored.ledger).toBe(stored.available + stored.pending);
      }
    });

    it('agrees with the sum of active holds', async () => {
      for (const organizationId of [org.a, org.b]) {
        const wallet = await walletOf(organizationId);
        const stored = await readBalances(prisma, wallet.id);
        const holds = await wiring.walletRepository.activeHoldTotal(wallet.id);
        expect(stored.pending).toBe(holds);
      }
    });
  });

  describe('a refund returns the funds and balances', () => {
    it('returns escrow to the payer without touching history', async () => {
      await fundWallet(wiring, org.c, 3_000_000n);

      const transaction = await asActor({ organizationId: org.c }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '3000000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );

      const wallet = await walletOf(org.c);
      expect((await readBalances(prisma, wallet.id)).available).toBe(0n);

      await asActor({ organizationId: org.c }, () =>
        wiring.transactions.refund(transaction.id, 'order cancelled by the buyer'),
      );

      const after = await readBalances(prisma, wallet.id);
      expect(after).toEqual({ available: 3_000_000n, pending: 0n, ledger: 3_000_000n });
      expect(await everyJournalBalances()).toEqual([]);
    });

    it('records the refund as a new journal, not as a reversal of the hold', async () => {
      // The distinction is not cosmetic: a reversal says the hold should never
      // have happened, a refund says it happened and the order was then
      // cancelled. An auditor reading the ledger a year later needs to tell
      // them apart.
      const journals = await runUnscoped('the audit reads the payer own journals', () =>
        prisma.client.journal.findMany({
          where: { organizationId: org.c },
          select: { journalType: true },
        }),
      );

      expect(journals.map((j) => j.journalType).sort()).toEqual([
        'FUNDS_HELD',
        'FUNDS_REFUNDED',
        'WALLET_TOP_UP',
      ]);
      expect(journals.map((j) => j.journalType)).not.toContain('REVERSAL');
    });
  });

  describe('reversal restores the exact prior balance', () => {
    it('returns a wallet to the balance it had before the journal', async () => {
      // docs/10 § 10.12: "معکوس کردن یک Journal، مانده حساب‌ها را به دقیقاً
      // وضعیت قبل برمی‌گرداند."
      const organizationId = org.c;
      const wallet = await walletOf(organizationId);
      const before = await readBalances(prisma, wallet.id);

      const topUp = await asActor({ organizationId }, () =>
        prisma.transaction(async (tx) => {
          const [locked] = await wiring.walletRepository.lock(tx, [wallet.id]);
          if (!locked) throw new Error('wallet vanished');
          return wiring.wallets.credit(tx, {
            wallet: locked,
            amountMinor: 777_777n,
            counterpartPurpose: 'PAYMENT_CLEARING',
            journalType: 'WALLET_TOP_UP',
            description: 'to be reversed',
            postedBy: 'itest',
          });
        }),
      );

      const afterCredit = await readBalances(prisma, wallet.id);
      expect(afterCredit.available).toBe(before.available + 777_777n);

      await asActor({ organizationId }, () =>
        prisma.transaction(async (tx) => {
          await wiring.ledger.reverse(tx, topUp.journalId, 'itest reversal', 'itest');
          const [locked] = await wiring.walletRepository.lock(tx, [wallet.id]);
          if (locked) await wiring.walletRepository.recomputeFromLedger(tx, locked);
        }),
      );

      expect(await readBalances(prisma, wallet.id)).toEqual(before);
      expect(await everyJournalBalances()).toEqual([]);
    });

    it('leaves the original journal and its entries untouched', async () => {
      // History is preserved: the reversal is an addition, never an edit.
      const reversal = await runUnscoped('the audit reads reversals across tenants', () =>
        prisma.client.journal.findFirst({
          where: { journalType: 'REVERSAL', organizationId: org.c },
          include: { entries: true },
        }),
      );

      expect(reversal).not.toBeNull();
      expect(reversal?.reversesId).toBeTruthy();
      expect(reversal?.reversalReason).toBe('itest reversal');

      const original = await runUnscoped('the audit reads reversals across tenants', () =>
        prisma.client.journal.findUnique({
          where: { id: reversal!.reversesId! },
          include: { entries: true },
        }),
      );
      expect(original?.description).toBe('to be reversed');
      expect(original?.entries).toHaveLength(2);
    });
  });

  describe('settlement order is enforced by the state machine', () => {
    it('refuses to settle a transaction nobody has authorised', async () => {
      // docs/10 § 10.12: "تسویه بدون ORDER_RECEIPT_CONFIRMED غیرممکن است."
      await fundWallet(wiring, org.a, 1_000_000n);

      const transaction = await asActor({ organizationId: org.a }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '1000000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );

      await expect(
        asActor({ organizationId: org.a }, () =>
          wiring.settlements.settle(transaction.id, 'USR-ITEST'),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));

      // And nothing moved: the funds are still in escrow.
      const wallet = await walletOf(org.a);
      expect((await readBalances(prisma, wallet.id)).pending).toBe(1_000_000n);
    });
  });

  describe('a dispute stops every automatic movement', () => {
    it('refuses to settle, and leaves the money exactly where it was', async () => {
      // docs/10 § 10.5 makes this a CONSTRAINT: "اعتراض ثبت‌شده = توقف کامل
      // تسویه. هیچ حرکت خودکاری تا رفع اختلاف انجام نمی‌شود."
      await fundWallet(wiring, org.a, 2_000_000n);

      const transaction = await asActor({ organizationId: org.a }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '2000000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );
      await asActor({ organizationId: org.a }, () =>
        wiring.transactions.authoriseSettlement(transaction.id),
      );
      await asActor({ organizationId: org.a }, () =>
        wiring.transactions.dispute(transaction.id, {
          reason: 'the delivered machine is not the one that was ordered',
        }),
      );

      const payeeBefore = await readBalances(prisma, (await walletOf(org.b)).id);

      await expect(
        asActor({ organizationId: org.a }, () =>
          wiring.settlements.settle(transaction.id, 'USR-ITEST'),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));

      // Not one rial moved, on either side.
      expect(await readBalances(prisma, (await walletOf(org.b)).id)).toEqual(payeeBefore);
      expect(await everyJournalBalances()).toEqual([]);
    });

    it('settles only after a human resolves the dispute', async () => {
      const disputed = await runUnscoped('the audit finds the disputed transaction', () =>
        prisma.client.transaction.findFirst({
          where: { organizationId: org.a, status: 'DISPUTED' },
        }),
      );
      expect(disputed).not.toBeNull();

      await asActor({ organizationId: org.a }, () =>
        wiring.transactions.resolveDispute(disputed!.id, {
          resolution: 'the supplier supplied the correct machine on a second delivery',
        }),
      );

      const settlement = await asActor({ organizationId: org.a }, () =>
        wiring.settlements.settle(disputed!.id, 'USR-ITEST'),
      );
      expect(settlement.settlementId).toBeTruthy();
      expect(await everyJournalBalances()).toEqual([]);
    });
  });

  describe('an overspend is impossible', () => {
    it('refuses a hold larger than the available balance', async () => {
      const empty = `${org.c}-EMPTY`;
      await fundWallet(wiring, empty, 100n);

      await expect(
        asActor({ organizationId: empty }, () =>
          wiring.transactions.create({
            transactionType: 'MARKETPLACE_ORDER',
            counterpartyOrganizationId: org.b,
            grossAmountMinor: '101',
            currency: 'IRR',
            holdFunds: true,
          }),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }));

      // And the whole request rolled back: no orphaned obligation is left
      // behind by the failed hold.
      const orphans = await asActor({ organizationId: empty }, () =>
        prisma.client.transaction.findMany({ where: { organizationId: empty } }),
      );
      expect(orphans).toEqual([]);

      await cleanup(prisma, [empty]);
    });
  });

  /** The organization's wallet, whatever it is called. */
  async function walletOf(organizationId: string) {
    const wallet = await runUnscoped('the audit reads both counterparties wallets', () =>
      prisma.client.wallet.findUnique({
        where: { organizationId_currency: { organizationId, currency: 'IRR' } },
      }),
    );
    if (!wallet) throw new Error(`no wallet for ${organizationId}`);
    return wallet;
  }
});
