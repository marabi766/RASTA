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
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * The generic journal reversal refuses every journal that has an owning
 * record (global audit L7-07, Recommendation A).
 *
 * Each case posts a real journal of one type through the path that owns it,
 * asks a platform administrator to reverse it, and asserts two things: the
 * 422 names the operation that corrects it (or says none exists yet, docs/24
 * Q-76), and **nothing was written** — no reversal journal, no entry, no
 * balance moved, the owning record as it was.
 */
describe('journal reversal refusals (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let reversals: JournalReversalService;
  const org = tenants();
  const payer = `${org.a}-REV`;
  const payee = `${org.b}-REV`;

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma);
    reversals = new JournalReversalService(prisma, wiring.ledger, wiring.walletRepository);
    await fundWallet(wiring, payer, 5_000_000n);
    await asActor({ organizationId: payee }, () => wiring.wallets.getOrOpen('IRR'));
  });

  afterAll(async () => {
    await cleanup(prisma, [payer, payee]);
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

  /** Everything a reversal would have touched, to compare before and after. */
  const snapshot = async () => {
    const [journals, entries, payerWallet, payeeWallet] = await Promise.all([
      runUnscoped('the suite counts journals', () =>
        prisma.client.journal.count({ where: { organizationId: { in: [payer, payee] } } }),
      ),
      runUnscoped('the suite counts entries', () =>
        prisma.client.ledgerEntry.count({ where: { organizationId: { in: [payer, payee] } } }),
      ),
      walletOf(payer),
      walletOf(payee),
    ]);
    return {
      journals,
      entries,
      payer: await readBalances(prisma, payerWallet),
      payee: await readBalances(prisma, payeeWallet),
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

  it('refuses a top-up, and names the payment refund', async () => {
    const journal = await latestJournal(payer, 'WALLET_TOP_UP');
    await expectRefused(journal.id, payer, /WALLET_TOP_UP.*payment-intents\/\{id\}\/refund/);
  });

  it('refuses a hold, names the transaction refund, and leaves the hold ACTIVE', async () => {
    const held = await createHeld('100000');
    const journal = await latestJournal(payer, 'FUNDS_HELD');
    await expectRefused(journal.id, payer, /FUNDS_HELD.*transactions\/\{id\}\/refund/);

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
    const journal = await latestJournal(payer, 'FUNDS_REFUNDED');
    await expectRefused(journal.id, payer, /FUNDS_REFUNDED.*Q-76/);
  });

  it('refuses a settlement, and leaves the transaction SETTLED', async () => {
    const held = await createHeld('130000');
    await asActor({ organizationId: payer }, () =>
      wiring.transactions.authoriseSettlement(held.id),
    );
    await asActor({ organizationId: payer }, () => wiring.settlements.settle(held.id, 'USR-ITEST'));
    const journal = await latestJournal(payer, 'SETTLEMENT');
    await expectRefused(journal.id, payer, /SETTLEMENT.*Q-76/);
    expect((await wiring.transactionRepository.findByIdForParty(held.id))?.status).toBe('SETTLED');
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
    const topUp = await latestJournal(payer, 'WALLET_TOP_UP');
    const reversal = await asActor({ organizationId: payer }, () =>
      prisma.transaction((tx) =>
        wiring.ledger.reverse(tx, topUp.id, 'the suite posts a reversal to test', 'itest'),
      ),
    );
    await expectRefused(reversal.id, payer, /cannot itself be reversed/);
  });

  it('still refuses a caller without platform scope before anything else', async () => {
    const journal = await latestJournal(payer, 'WALLET_TOP_UP');
    await expect(
      asActor({ organizationId: payer }, () => reversals.reverse(journal.id, 'not my decision')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
