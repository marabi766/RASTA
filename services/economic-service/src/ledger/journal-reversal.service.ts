import { Injectable } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletRepository } from '../wallet/wallet.repository';
import { assertPlatformScope, canCommitOrganization } from '../access/access';
import { LedgerService } from './ledger.service';
import type { JournalType } from '../generated/prisma';

/**
 * The operation that corrects a journal of each type, when it is not a bare
 * ledger reversal (global audit L7-07).
 *
 * Every journal this service posts is the ledger half of a record that owns
 * it: a payment intent, a hold and its transaction, a settlement with its
 * commission, a reward. A reversal posted through the generic endpoint moved
 * the money back and left that record saying the opposite — a hold still
 * ACTIVE over escrow that had gone, a transaction still SETTLED over a payment
 * the ledger had undone, a reward still monetised over a credit clawed back.
 * So a journal with an owner is corrected through the owner's operation, which
 * moves the record and the ledger together, or not at all.
 *
 * Typed over the whole `JournalType` enum: a new journal type does not compile
 * until it says who owns it. `null` means no owner; the ledger decides alone.
 * `REVERSAL` is the only one, and `LedgerService.reverse` refuses it (a
 * reversal is never itself reversed).
 *
 * The three without an operation are docs/24 Q-76: what reversing a
 * settlement, or clawing back a reward, means for the records that own them
 * is a product decision nobody has made, and none is invented here.
 */
export const CORRECTION_OF: { readonly [T in JournalType]: string | null } = {
  WALLET_TOP_UP:
    'a top-up is corrected by refunding its payment: POST /v1/payment-intents/{id}/refund',
  FUNDS_HELD: 'a hold is returned by refunding its transaction: POST /v1/transactions/{id}/refund',
  FUNDS_REFUNDED: 'a refund is final; no operation undoes one yet (docs/24 Q-76)',
  SETTLEMENT:
    'no operation reverses a settlement yet; what that means for the order, transaction, ' +
    'settlement and commission is open (docs/24 Q-76)',
  REWARD_GRANT: 'no operation claws back a reward yet (docs/24 Q-76)',
  REVERSAL: null,
};

/**
 * `POST /v1/ledger/journals/{id}/reverse` (AGENTS.md A-06, A-10).
 *
 * Lifted out of `LedgerController`, which decided who may reverse, which
 * journals may be reversed, and which wallets to recompute — business logic in
 * a controller. `LedgerService.reverse` is unchanged: it is the ledger half the
 * owning operations use (the payment refund does), and it knows nothing of
 * owners.
 */
@Injectable()
export class JournalReversalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletRepository,
  ) {}

  /**
   * Reverses a journal no record owns, or refuses with a 422 naming the
   * operation that corrects it. A refusal writes nothing.
   *
   * Restricted to platform administrators. Reversing a journal changes what
   * two organizations' balances are; in a single tenant's hands it would let
   * one party unwind a movement the other relied on.
   */
  async reverse(
    journalId: string,
    reason: string,
  ): Promise<{ journalId: string; reversesId: string; postedAt: string }> {
    assertPlatformScope('Reversing a journal');

    const original = await this.ledger.getJournal(journalId);
    canCommitOrganization(original.organizationId);

    const correction = CORRECTION_OF[original.journalType];
    if (correction !== null) {
      throw RastaError.businessRule(
        `A ${original.journalType} journal is not reversed through the ledger: ${correction}`,
        { journalId, journalType: original.journalType },
      );
    }

    return this.prisma.transaction(async (tx) => {
      const reversal = await this.ledger.reverse(tx, journalId, reason, 'platform-administrator');

      // Every wallet whose account appears in the reversal is brought back
      // into line with the ledger in the same transaction, or the two disagree
      // until the reconciliation notices.
      const organizations = new Set(reversal.entries.map((entry) => entry.organizationId));
      for (const organizationId of organizations) {
        const wallet = await this.wallets.findByOrganizationUnscoped(
          tx,
          organizationId,
          reversal.currency,
        );
        if (!wallet) continue;
        const [locked] = await this.wallets.lock(tx, [wallet.id]);
        if (locked) await this.wallets.recomputeFromLedger(tx, locked);
      }

      return {
        journalId: reversal.id,
        reversesId: journalId,
        postedAt: reversal.postedAt.toISOString(),
      };
    });
  }
}
