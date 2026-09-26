import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { CORRECTION_OF, JournalReversalService } from './journal-reversal.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { LedgerService } from './ledger.service';
import type { WalletRepository } from '../wallet/wallet.repository';
import type { TransactionRepository } from '../transaction/transaction.repository';

/**
 * Which journals the generic reversal may post (global audit L7-07).
 *
 * The table is typed over the whole `JournalType` enum, so a new type does not
 * compile without an entry; this pins what each entry says.
 */
describe('CORRECTION_OF', () => {
  it('leaves only a reversal to the ledger, which refuses it itself', () => {
    const unowned = Object.entries(CORRECTION_OF)
      .filter(([, correction]) => correction === null)
      .map(([type]) => type);
    expect(unowned).toEqual(['REVERSAL']);
  });

  it('names the operation where one exists, and the open question where none does', () => {
    expect(CORRECTION_OF.WALLET_TOP_UP).toContain('POST /v1/payment-intents/{id}/refund');
    expect(CORRECTION_OF.FUNDS_HELD).toContain('POST /v1/transactions/{id}/refund');
    for (const type of ['FUNDS_REFUNDED', 'SETTLEMENT', 'REWARD_GRANT'] as const) {
      expect(CORRECTION_OF[type]).toContain('docs/24 Q-76');
    }
  });
});

/**
 * A hold journal whose owners cannot be found — a state no owning path
 * produces, so only reachable here. The real-database cases (ACTIVE, RELEASED,
 * REFUNDED) are in `test/journal-reversal.int-spec.ts`.
 */
describe('JournalReversalService FUNDS_HELD guidance', () => {
  const platform: RequestContext = {
    correlationId: 'unit',
    requestId: 'unit',
    organizationId: 'ORG-UNIT',
    userId: 'USR-UNIT',
    roles: ['UNION_ADMIN'],
    organizationIds: [],
    authType: 'USER',
    startedAt: Date.now(),
  };

  const serviceWith = (
    transactionId: string | null,
    transaction: { organizationId: string; status: string } | null,
  ) =>
    new JournalReversalService(
      {} as PrismaService,
      {
        getJournal: async () => ({
          id: 'JRN_UNIT',
          organizationId: 'ORG-UNIT',
          journalType: 'FUNDS_HELD',
          transactionId,
        }),
      } as unknown as LedgerService,
      { findHoldPlacedBy: async () => null } as unknown as WalletRepository,
      { findByIdForParty: async () => transaction } as unknown as TransactionRepository,
    );

  it.each([
    ['no transaction on the journal', null, null],
    [
      'a transaction another organization pays',
      'TXN_UNIT',
      { organizationId: 'ORG-OTHER', status: 'HELD' },
    ],
  ])('names Q-76, not the refund, for %s and no hold', async (_case, transactionId, found) => {
    const failure = await runWithContext(platform, async () =>
      serviceWith(transactionId, found).reverse('JRN_UNIT', 'a unit test asks'),
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'BUSINESS_RULE_VIOLATION', status: 422 });
    const message = (failure as Error).message;
    expect(message).toContain('the hold is not found and its transaction not found');
    expect(message).toContain('docs/24 Q-76');
    expect(message).not.toContain('/v1/transactions/{id}/refund');
  });
});
