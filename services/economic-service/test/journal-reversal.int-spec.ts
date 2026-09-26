import { ulid } from 'ulid';
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
import { JournalReversalService } from '../src/ledger/journal-reversal.service';
import { PaymentService, type TopUpResult } from '../src/payment/payment.service';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { JournalType } from '../src/generated/prisma';

/**
 * The generic journal reversal refuses every journal that has an owning
 * record (global audit L7-07, Recommendation A).
 *
 * Each case posts a real journal of one type through the path that owns it —
 * the top-up through `PaymentService`, so it has the intent and transaction
 * the payment refund needs — asks a platform administrator to reverse it, and
 * asserts two things: the 422 names the operation that corrects it *in the
 * owner's current state* (or says none exists yet, docs/24 Q-76), and
 * **nothing was written** — no journal, entry, balance, outbox message (the
 * audit trail leaves through the outbox), idempotency row or owning row
 * changed.
 */
describe('journal reversal refusals (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let reversals: JournalReversalService;
  let topUpIds: { paymentIntentId: string; transactionId: string; journalId: string };
  const org = tenants();
  const payer = `${org.a}-REV`;
  const payee = `${org.b}-REV`;
  const unownedOrg = `${org.c}-REV-POST`;

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma);
    reversals = new JournalReversalService(
      prisma,
      wiring.ledger,
      wiring.walletRepository,
      wiring.transactionRepository,
    );
    const payments = new PaymentService(
      prisma,
      wiring.ledger,
      wiring.wallets,
      wiring.walletRepository,
      new MockPaymentProvider(),
    );
    const wallet = await asActor({ organizationId: payer }, () => wiring.wallets.getOrOpen('IRR'));
    const topUp: TopUpResult = await asActor({ organizationId: payer }, () =>
      payments.topUp(wallet.id, { amountMinor: '5000000', idempotencyKey: `itest-rev-${ulid()}` }),
    );
    if (topUp.status !== 'CAPTURED' || !topUp.transactionId || !topUp.journalId) {
      throw new Error('the suite’s top-up was not captured');
    }
    topUpIds = { ...topUp, transactionId: topUp.transactionId, journalId: topUp.journalId };
    await asActor({ organizationId: payee }, () => wiring.wallets.getOrOpen('IRR'));
  });

  afterAll(async () => {
    await cleanup(prisma, [payer, payee, unownedOrg]);
    await prisma.onModuleDestroy();
  });

  /** A platform administrator acting from the journal's own organization. */
  const asPlatform = <T>(organizationId: string, fn: () => Promise<T>) =>
    asActor({ organizationId, userId: 'USR-ITEST-PLATFORM', roles: ['UNION_ADMIN'] }, fn);

  const latestJournal = async (organizationId: string, journalType: string) => {
    const journal = await runUnscoped('the suite finds the journal it just caused', () =>
      prisma.client.journal.findFirst({
        where: { organizationId, journalType: journalType as never },
        orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
      }),
    );
    if (!journal) throw new Error(`no ${journalType} journal for ${organizationId}`);
    return journal;
  };

  const journalOf = async (transactionId: string, journalType: JournalType) =>
    runUnscoped('the suite finds a transaction’s journal', () =>
      prisma.client.journal.findFirstOrThrow({ where: { transactionId, journalType } }),
    );

  /**
   * Everything a reversal would have touched, row by row, to compare before
   * and after: the ledger, the wallets, the outbox, idempotency, and every
   * record that owns a journal.
   */
  const snapshot = async () => {
    const where = { organizationId: { in: [payer, payee] } };
    const byId = { id: 'asc' } as const;
    const rows = await runUnscoped('the suite reads every row a reversal could touch', () =>
      Promise.all([
        prisma.client.journal.findMany({ where, orderBy: byId }),
        prisma.client.ledgerEntry.findMany({ where, orderBy: byId }),
        prisma.client.wallet.findMany({ where, orderBy: byId }),
        prisma.client.walletHold.findMany({ where, orderBy: byId }),
        prisma.client.transaction.findMany({ where, orderBy: byId }),
        prisma.client.paymentIntent.findMany({ where, orderBy: byId }),
        prisma.client.settlement.findMany({ where, orderBy: byId }),
        prisma.client.commission.findMany({ where, orderBy: byId }),
        prisma.client.reward.findMany({ where, orderBy: byId }),
        prisma.client.outboxMessage.findMany({ where, orderBy: byId }),
        prisma.client.idempotencyKey.findMany({ where, orderBy: { key: 'asc' } }),
      ]),
    );
    return {
      rows,
      payer: await readBalances(prisma, await walletOf(payer)),
      payee: await readBalances(prisma, await walletOf(payee)),
    };
  };

  async function walletOf(organizationId: string): Promise<string> {
    const wallet = await runUnscoped('the suite reads a wallet under test', () =>
      prisma.client.wallet.findUniqueOrThrow({
        where: { organizationId_currency: { organizationId, currency: 'IRR' } },
      }),
    );
    return wallet.id;
  }

  /** Asks for the reversal and asserts the refusal, and that nothing moved. */
  async function expectRefused(journalId: string, organizationId: string, names: RegExp) {
    const before = await snapshot();

    const failure = await asPlatform(organizationId, () =>
      reversals.reverse(journalId, 'an itest asks for the generic reversal'),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'BUSINESS_RULE_VIOLATION', status: 422 });
    expect((failure as Error).message).toMatch(names);

    expect(await snapshot()).toEqual(before);
    const reversalsOf = await runUnscoped('the suite looks for a reversal', () =>
      prisma.client.journal.count({ where: { reversesId: journalId } }),
    );
    expect(reversalsOf).toBe(0);
  }

  async function expectNoRefundNamed(journalId: string) {
    const failure = await asPlatform(payer, () =>
      reversals.reverse(journalId, 'an itest asks for the generic reversal'),
    ).catch((error: unknown) => error);
    expect((failure as Error).message).not.toContain('/v1/transactions/{id}/refund');
  }

  const createHeld = (amountMinor: string) =>
    asActor({ organizationId: payer }, () =>
      wiring.transactions.create({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: amountMinor,
        currency: 'IRR',
        holdFunds: true,
      }),
    );

  it('refuses a top-up, and names the payment refund its intent can take', async () => {
    // Posted by `PaymentService.topUp`: the journal, its transaction and its
    // intent are one record, which the snapshot shows unchanged.
    const journal = await journalOf(topUpIds.transactionId, 'WALLET_TOP_UP');
    expect(journal.id).toBe(topUpIds.journalId);
    await expectRefused(journal.id, payer, /WALLET_TOP_UP.*payment-intents\/\{id\}\/refund/);
  });

  it('refuses a hold, names the transaction refund, and leaves the hold ACTIVE', async () => {
    const held = await createHeld('100000');
    const journal = await journalOf(held.id, 'FUNDS_HELD');
    // Codex round 2, F5: the guidance reads the transaction through the tenant
    // guard, never the unscoped party read.
    const unscoped = jest.spyOn(wiring.transactionRepository, 'findByIdForParty');
    await expectRefused(journal.id, payer, /FUNDS_HELD.*transactions\/\{id\}\/refund/);
    expect(unscoped).not.toHaveBeenCalled();
    unscoped.mockRestore();
    // And that guarded read does not find this transaction from another
    // organization, which is what makes a foreign one "not found".
    expect(
      await asActor({ organizationId: unownedOrg }, () =>
        wiring.transactionRepository.findById(held.id),
      ),
    ).toBeNull();

    const holds = await runUnscoped('the suite reads the hold', () =>
      prisma.client.walletHold.findMany({ where: { reference: held.id } }),
    );
    expect(holds.map((hold) => hold.status)).toEqual(['ACTIVE']);
    expect((await wiring.transactionRepository.findByIdForParty(held.id))?.status).toBe('HELD');
  });

  it('refuses a refund, which is final until Q-76 is answered', async () => {
    const held = await createHeld('120000');
    await asActor(
      { organizationId: payer, userId: 'marketplace-service', authType: 'SERVICE' },
      () => wiring.transactions.refund(held.id, 'order cancelled'),
    );
    const journal = await journalOf(held.id, 'FUNDS_REFUNDED');
    await expectRefused(journal.id, payer, /FUNDS_REFUNDED.*Q-76/);

    // Its hold journal no longer has a refund to name: that refund happened.
    const hold = await journalOf(held.id, 'FUNDS_HELD');
    await expectRefused(hold.id, payer, /hold is REFUNDED and its transaction REFUNDED.*Q-76/);
    await expectNoRefundNamed(hold.id);
  });

  it('refuses a settlement, and leaves the transaction SETTLED', async () => {
    const held = await createHeld('130000');
    await asActor({ organizationId: payer }, () =>
      wiring.transactions.authoriseSettlement(held.id),
    );
    await asActor({ organizationId: payer }, () => wiring.settlements.settle(held.id, 'USR-ITEST'));
    const journal = await journalOf(held.id, 'SETTLEMENT');
    await expectRefused(journal.id, payer, /SETTLEMENT.*Q-76/);
    expect((await wiring.transactionRepository.findByIdForParty(held.id))?.status).toBe('SETTLED');

    // Codex round 1, F2: the transaction refund would answer 409 for a SETTLED
    // transaction, so the hold journal's refusal names Q-76 instead.
    const hold = await journalOf(held.id, 'FUNDS_HELD');
    await expectRefused(hold.id, payer, /hold is RELEASED and its transaction SETTLED.*Q-76/);
    await expectNoRefundNamed(hold.id);
  });

  it('refuses a reward grant, and leaves the reward as it was', async () => {
    const userId = `USR-ITEST-REV-${ulid().slice(-6)}`;
    await asActor({ organizationId: payer, roles: ['SYSTEM_ADMIN'] }, () =>
      wiring.rewards.createRule({
        organizationId: payer,
        triggerEvent: 'USAGE_RECORDED',
        rewardType: 'POINTS',
        points: 2,
        creditPerPointMinor: '1000',
        status: 'ACTIVE',
        validFrom: new Date(Date.now() - 60_000).toISOString(),
      } as never),
    );
    const [outcome] = await asActor({ organizationId: payer, userId }, () =>
      wiring.rewards.grantFor({
        organizationId: payer,
        userId,
        triggerEvent: 'USAGE_RECORDED',
        sourceReference: `USG_${ulid()}`,
        occurredAt: new Date(),
        payload: {},
      }),
    );
    expect(outcome?.kind).toBe('GRANTED');

    const journal = await latestJournal(payer, 'REWARD_GRANT');
    await expectRefused(journal.id, payer, /REWARD_GRANT.*Q-76/);
  });

  it('refuses to reverse a reversal, through the ledger’s own rule', async () => {
    // The one type no record owns: the ledger itself refuses it, and nothing
    // is written either.
    const reversal = await asActor({ organizationId: payer }, () =>
      prisma.transaction((tx) =>
        wiring.ledger.reverse(
          tx,
          topUpIds.journalId,
          'the suite posts a reversal to test',
          'itest',
        ),
      ),
    );
    await expectRefused(reversal.id, payer, /cannot itself be reversed/);
  });

  it('still refuses a caller without platform scope before anything else', async () => {
    await expect(
      asActor({ organizationId: payer }, () => reversals.reverse(topUpIds.journalId, 'not mine')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('posts the reversal and recomputes every touched wallet for a journal no record owns', async () => {
    // No journal type is unowned today, so the posting path is reached by
    // declaring one unowned in a subclass — the path a future type without
    // an owner would take. A top-up's legs are the payer's wallet account and
    // the platform's clearing account, whose organization has no wallet.
    class TopUpsUnowned extends JournalReversalService {
      protected override correctionFor(type: JournalType): string | null {
        return type === 'WALLET_TOP_UP' ? null : super.correctionFor(type);
      }
    }
    const unowned = new TopUpsUnowned(
      prisma,
      wiring.ledger,
      wiring.walletRepository,
      wiring.transactionRepository,
    );

    const organizationId = unownedOrg;
    const { walletId } = await fundWallet(wiring, organizationId, 40_000n);
    const topUp = await latestJournal(organizationId, 'WALLET_TOP_UP');
    expect((await readBalances(prisma, walletId)).available).toBe(40_000n);

    const result = await asPlatform(organizationId, () =>
      unowned.reverse(topUp.id, 'the suite reverses an unowned journal'),
    );
    expect(result.reversesId).toBe(topUp.id);
    // Recomputed in the same transaction: the wallet agrees with the ledger.
    expect((await readBalances(prisma, walletId)).available).toBe(0n);

    // And at most once.
    await expect(
      asPlatform(organizationId, () => unowned.reverse(topUp.id, 'a second reversal is refused')),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    // Cleaned up with the suite's other tenants in afterAll: a mid-suite
    // cleanup also deletes this run's reward rules by author, while the
    // reward granted to another tenant above still references one.
  });
});
