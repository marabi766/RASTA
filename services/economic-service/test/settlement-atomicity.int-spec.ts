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
 * Settlement atomicity (ADR-031, docs/08 § 8.6, docs/10 § 10.10).
 *
 * The claim being tested is the one that lets this platform have **no
 * automatic financial compensation**:
 *
 * > If any step of a settlement throws, none of them happened.
 *
 * That is what makes "the funds stay held and a human decides" a safe policy
 * rather than a reckless one — there is nothing half-done to compensate for.
 *
 * The failure is injected *after* the journal is posted and the wallets are
 * recomputed, which is the only interesting place: a failure before anything
 * moved proves nothing.
 */
describe('settlement atomicity (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma);

    // The payee's wallet is opened up front, with no balance.
    //
    // Not incidental: `settle` opens a counterparty wallet inside its own
    // transaction, so a settlement that rolls back leaves the payee with no
    // wallet at all — correct behaviour, and it would make "compare the payee
    // balance before and after" impossible to write. Opening it first is what
    // lets the assertion below be about money rather than about existence.
    await fundWallet(wiring, org.b, 0n);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  /** A held, authorised transaction ready to settle. */
  async function readyToSettle(payer: string, amountMinor: string) {
    await fundWallet(wiring, payer, BigInt(amountMinor));

    const transaction = await asActor({ organizationId: payer }, () =>
      wiring.transactions.create({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: org.b,
        grossAmountMinor: amountMinor,
        currency: 'IRR',
        holdFunds: true,
      }),
    );
    await asActor({ organizationId: payer }, () =>
      wiring.transactions.authoriseSettlement(transaction.id),
    );
    return transaction;
  }

  async function walletId(organizationId: string): Promise<string> {
    const wallet = await runUnscoped('the atomicity audit reads both counterparties', () =>
      prisma.client.wallet.findUnique({
        where: { organizationId_currency: { organizationId, currency: 'IRR' } },
      }),
    );
    if (!wallet) throw new Error(`no wallet for ${organizationId}`);
    return wallet.id;
  }

  it('leaves no journal, no balance change and no commission when a late step fails', async () => {
    const payer = `${org.a}-ATOMIC`;
    const transaction = await readyToSettle(payer, '3000000');

    const payerWallet = await walletId(payer);
    const payeeWallet = await walletId(org.b);
    const payerBefore = await readBalances(prisma, payerWallet);
    const payeeBefore = await readBalances(prisma, payeeWallet);

    // Fail *after* the journal has been written and both balances recomputed.
    // Everything up to that point has already touched the database inside the
    // transaction, so a rollback is the only thing that can undo it.
    const record = jest
      .spyOn(wiring.commissions, 'record')
      .mockRejectedValueOnce(new Error('injected failure after the journal was posted'));

    await expect(
      asActor({ organizationId: payer }, () =>
        wiring.settlements.settle(transaction.id, 'USR-ITEST'),
      ),
    ).rejects.toThrow('injected failure');

    record.mockRestore();

    // Nothing moved.
    expect(await readBalances(prisma, payerWallet)).toEqual(payerBefore);
    expect(await readBalances(prisma, payeeWallet)).toEqual(payeeBefore);

    // No journal.
    const journals = await runUnscoped('the atomicity audit counts journals per transaction', () =>
      prisma.client.journal.findMany({
        where: { transactionId: transaction.id, journalType: 'SETTLEMENT' },
      }),
    );
    expect(journals).toEqual([]);

    // No commission, and no settlement record.
    const commission = await runUnscoped('the atomicity audit reads the payee commission', () =>
      prisma.client.commission.findUnique({ where: { transactionId: transaction.id } }),
    );
    expect(commission).toBeNull();

    const settlement = await runUnscoped('the atomicity audit reads the settlement', () =>
      prisma.client.settlement.findUnique({ where: { transactionId: transaction.id } }),
    );
    expect(settlement).toBeNull();

    await cleanup(prisma, [payer]);
  });

  it('leaves the funds held rather than refunding them automatically', async () => {
    // docs/08 § 8.6 and docs/10 § 10.10: no automatic compensation after a
    // failed settlement. Returning money in response to an undiagnosed failure
    // is a larger risk than the failure.
    const payer = `${org.a}-HELD`;
    const transaction = await readyToSettle(payer, '2000000');

    const record = jest
      .spyOn(wiring.commissions, 'record')
      .mockRejectedValueOnce(new Error('injected failure'));

    await expect(
      asActor({ organizationId: payer }, () =>
        wiring.settlements.settle(transaction.id, 'USR-ITEST'),
      ),
    ).rejects.toThrow('injected failure');

    record.mockRestore();

    const balances = await readBalances(prisma, await walletId(payer));
    expect(balances.pending).toBe(2_000_000n);
    expect(balances.available).toBe(0n);

    const hold = await runUnscoped('the atomicity audit reads the hold', () =>
      prisma.client.walletHold.findFirst({ where: { reference: transaction.id } }),
    );
    expect(hold?.status).toBe('ACTIVE');

    await cleanup(prisma, [payer]);
  });

  it('leaves the transaction settleable, so a retry works once the fault is fixed', async () => {
    const payer = `${org.a}-RETRY`;
    const transaction = await readyToSettle(payer, '1500000');

    const record = jest
      .spyOn(wiring.commissions, 'record')
      .mockRejectedValueOnce(new Error('transient failure'));

    await expect(
      asActor({ organizationId: payer }, () =>
        wiring.settlements.settle(transaction.id, 'USR-ITEST'),
      ),
    ).rejects.toThrow('transient failure');

    record.mockRestore();

    // Still PENDING_SETTLEMENT — the status change is part of the same
    // transaction, so a failed attempt does not consume the transaction.
    const after = await asActor({ organizationId: payer }, () =>
      wiring.transactions.get(transaction.id),
    );
    expect(after.status).toBe('PENDING_SETTLEMENT');

    const settlement = await asActor({ organizationId: payer }, () =>
      wiring.settlements.settle(transaction.id, 'USR-ITEST'),
    );
    expect(settlement.settlementId).toBeTruthy();

    await cleanup(prisma, [payer]);
  });

  it('refuses to settle when the held amount does not match the obligation', async () => {
    // A mismatch means somebody changed one of the two out of band. Settling
    // either figure would be a guess about which is right, so it is refused
    // and left for a person.
    const payer = `${org.a}-MISMATCH`;
    const transaction = await readyToSettle(payer, '1000000');

    await runUnscoped('the mismatch test corrupts a hold deliberately', () =>
      prisma.client.$executeRawUnsafe(
        `UPDATE wallet_hold SET amount_minor = 999999 WHERE reference = $1`,
        transaction.id,
      ),
    );

    await expect(
      asActor({ organizationId: payer }, () =>
        wiring.settlements.settle(transaction.id, 'USR-ITEST'),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }));

    await cleanup(prisma, [payer]);
  });

  it('settles an obligation that was never held, from the spendable balance', async () => {
    // The maintenance case (ADR-032): the work is done and the amount is owed,
    // so there is no escrow behind it and the payer pays from what they have.
    const payer = `${org.c}-NOHOLD`;
    await fundWallet(wiring, payer, 4_000_000n);

    const obligation = await asActor({ organizationId: payer }, () =>
      prisma.transaction((tx) =>
        wiring.transactions.recordAuthorisedObligation(tx, {
          organizationId: payer,
          counterpartyOrganizationId: org.b,
          transactionType: 'MAINTENANCE_SERVICE',
          grossAmountMinor: 1_200_000n,
          currency: 'IRR',
          occurredAt: new Date(),
          sourceType: 'MAINTENANCE_REQUEST',
          sourceReference: `MNT_ITEST_${Date.now()}`,
        }),
      ),
    );

    // Recorded, and nothing moved yet — that is the whole point of ADR-032.
    const beforeSettle = await readBalances(prisma, await walletId(payer));
    expect(beforeSettle.available).toBe(4_000_000n);
    expect(beforeSettle.pending).toBe(0n);

    const settlement = await asActor({ organizationId: payer }, () =>
      wiring.settlements.settle(obligation.id, 'USR-ITEST'),
    );

    expect(settlement.netAmountMinor).toBe(1_200_000n);

    const after = await readBalances(prisma, await walletId(payer));
    expect(after.available).toBe(2_800_000n);
    expect(after.pending).toBe(0n);

    await cleanup(prisma, [payer]);
  });

  it('refuses an unheld obligation the payer cannot afford, and changes nothing', async () => {
    const payer = `${org.c}-POOR`;
    await fundWallet(wiring, payer, 100n);

    const obligation = await asActor({ organizationId: payer }, () =>
      prisma.transaction((tx) =>
        wiring.transactions.recordAuthorisedObligation(tx, {
          organizationId: payer,
          counterpartyOrganizationId: org.b,
          transactionType: 'MAINTENANCE_SERVICE',
          grossAmountMinor: 5_000_000n,
          currency: 'IRR',
          occurredAt: new Date(),
          sourceType: 'MAINTENANCE_REQUEST',
          sourceReference: `MNT_ITEST_POOR_${Date.now()}`,
        }),
      ),
    );

    await expect(
      asActor({ organizationId: payer }, () =>
        wiring.settlements.settle(obligation.id, 'USR-ITEST'),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }));

    // The obligation survives — it is still owed, and still visible in the
    // pending-settlement queue. That is the outcome ADR-032 chose over
    // dead-lettering an approval.
    const after = await asActor({ organizationId: payer }, () =>
      wiring.transactions.get(obligation.id),
    );
    expect(after.status).toBe('PENDING_SETTLEMENT');
    expect((await readBalances(prisma, await walletId(payer))).available).toBe(100n);

    await cleanup(prisma, [payer]);
  });
});
