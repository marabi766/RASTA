import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { isUniqueViolation } from '../ledger/ledger.repository';
import { WalletRepository, type LockedWallet } from './wallet.repository';
import { assertSufficient, balancesFrom, type Balances } from './balances';
import { ECONOMIC_EVENTS } from '../events/events';
import { formatMinor } from '../shared/money';
import { holdsActiveTotal, holdsRefusedTotal } from '../observability/metrics';
import { SERVICE_NAME } from '../config/env';

/**
 * Wallets, holds, and the hold/release cycle the product document requires
 * (docs/10 § 10.5).
 *
 * ## The shape every mutation here takes
 *
 * ```
 *   lock the wallet row(s), in id order      ← ADR-031: no deadlock, no lost update
 *   read the balances under that lock        ← the only reading that is still true
 *   check the rule (sufficient? active?)     ← produces the user-facing error
 *   post a balanced journal                  ← the ledger is what actually moved
 *   recompute the balances from the ledger   ← ADR-034: never incremented
 *   write the outbox row                     ← same transaction (ADR-021)
 * ```
 *
 * Every step is inside one transaction opened by the caller. There is no step
 * that happens "afterwards", because a step that happens afterwards is a step
 * that can fail after the money moved.
 *
 * ## Why a hold is a journal rather than a column
 *
 * Escrowed funds are moved into the payer's own escrow account, so "how much
 * of my money is committed" is a ledger balance rather than an application
 * annotation — auditable, visible in the trial balance, and reconcilable
 * against the holds table (ADR-034).
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly repository: WalletRepository,
    private readonly ledger: LedgerService,
    private readonly prisma: PrismaService,
  ) {}

  // ==========================================================================
  // Opening
  // ==========================================================================

  /**
   * Returns the caller's wallet, opening it on first use.
   *
   * Opening is lazy rather than driven by an organization-created event,
   * because `economic-service` does not consume `ORGANIZATION_CREATED` and
   * adding that subscription only to create a row nobody has asked for would
   * mean every organization on the platform carries an empty wallet and an
   * empty pair of ledger accounts.
   */
  async getOrOpen(currency = 'IRR') {
    const organizationId = getOrganizationId();
    const existing = await this.repository.findByOrganization(organizationId, currency);
    if (existing) return existing;

    return this.open(organizationId, currency);
  }

  /**
   * Opens a wallet and its two ledger accounts.
   *
   * The accounts come first and the wallet references one of them, so a wallet
   * without a ledger account behind it is not expressible — the foreign key
   * `fk_wallet_account_identity` also pins the pair to the same organization
   * and currency.
   *
   * The escrow account is created here too, even though nothing has been held
   * yet. Creating it lazily at the first hold would put an account creation
   * inside a money-moving transaction, where a race on
   * `(organization_id, purpose, currency)` would roll back a settlement rather
   * than an idle setup step.
   */
  async open(organizationId: string, currency: string) {
    const actor = getContext().userId ?? SERVICE_NAME;

    try {
      return await this.prisma.transaction(async (tx) => {
        const walletAccount = await this.ledger.resolveAccount(
          tx,
          'WALLET',
          organizationId,
          currency,
          actor,
        );
        await this.ledger.resolveAccount(tx, 'ESCROW', organizationId, currency, actor);

        const walletId = `${ID_PREFIXES.wallet}_${ulid()}`;
        const wallet = await this.repository.create(tx, {
          id: walletId,
          organizationId,
          currency,
          ledgerAccountId: walletAccount.id,
        });

        await this.ledger.enqueue(tx, {
          eventName: ECONOMIC_EVENTS.WALLET_OPENED,
          aggregateId: walletId,
          organizationId,
          payload: {
            walletId,
            organizationId,
            currency,
            openedAt: wallet.createdAt.toISOString(),
          },
        });

        return wallet;
      });
    } catch (error) {
      // `(organization_id, currency)` is unique, so a concurrent first request
      // for the same organization loses this race. Its wallet is as good as
      // ours would have been.
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.repository.findByOrganization(organizationId, currency);
      if (!raced) throw error;
      return raced;
    }
  }

  /**
   * Resolves a counterparty's wallet during a settlement, opening it if needed.
   *
   * A supplier that has never held a balance still has to be payable. Opening
   * their wallet inside the settlement transaction is deliberate: the
   * alternative is refusing to settle until they log in once, which would
   * strand a completed piece of work behind an administrative step.
   */
  async resolveCounterpartyWallet(
    tx: ExtendedPrismaClient,
    organizationId: string,
    currency: string,
  ) {
    const existing = await this.repository.findByOrganizationUnscoped(tx, organizationId, currency);
    if (existing) return existing;

    const actor = getContext().userId ?? SERVICE_NAME;
    const walletAccount = await this.ledger.resolveAccount(
      tx,
      'WALLET',
      organizationId,
      currency,
      actor,
    );
    await this.ledger.resolveAccount(tx, 'ESCROW', organizationId, currency, actor);

    const walletId = `${ID_PREFIXES.wallet}_${ulid()}`;
    const wallet = await this.repository.create(tx, {
      id: walletId,
      organizationId,
      currency,
      ledgerAccountId: walletAccount.id,
    });

    await this.ledger.enqueue(tx, {
      eventName: ECONOMIC_EVENTS.WALLET_OPENED,
      aggregateId: walletId,
      organizationId,
      payload: {
        walletId,
        organizationId,
        currency,
        openedAt: wallet.createdAt.toISOString(),
      },
    });

    return wallet;
  }

  // ==========================================================================
  // Credit
  // ==========================================================================

  /**
   * Credits a wallet, posting the journal that justifies it.
   *
   * Used by the top-up path and by a monetised reward. The counterpart account
   * differs — payment clearing for a top-up, reward expense for a reward — so
   * it is a parameter rather than a branch: this method's job is "credit a
   * wallet against something", and what that something is belongs to the
   * caller who knows why.
   */
  async credit(
    tx: ExtendedPrismaClient,
    input: {
      wallet: LockedWallet | { id: string; organizationId: string; currency: string };
      amountMinor: bigint;
      counterpartPurpose: 'PAYMENT_CLEARING' | 'REWARD_EXPENSE';
      journalType: 'WALLET_TOP_UP' | 'REWARD_GRANT';
      description: string;
      transactionId?: string | null;
      postedBy: string;
    },
  ): Promise<{ journalId: string; balances: Balances }> {
    if (input.amountMinor <= 0n) {
      throw RastaError.businessRule('A credit must be positive', { walletId: input.wallet.id });
    }

    const walletAccount = await this.ledger.resolveAccount(
      tx,
      'WALLET',
      input.wallet.organizationId,
      input.wallet.currency,
      input.postedBy,
    );
    const counterpart = await this.ledger.resolveAccount(
      tx,
      input.counterpartPurpose,
      input.wallet.organizationId,
      input.wallet.currency,
      input.postedBy,
    );

    const journal = await this.ledger.post(
      tx,
      {
        journalType: input.journalType,
        description: input.description,
        organizationId: input.wallet.organizationId,
        transactionId: input.transactionId ?? null,
        entries: [
          {
            accountId: counterpart.id,
            organizationId: counterpart.organizationId,
            direction: 'DEBIT',
            amountMinor: input.amountMinor,
            currency: input.wallet.currency,
          },
          {
            accountId: walletAccount.id,
            organizationId: walletAccount.organizationId,
            direction: 'CREDIT',
            amountMinor: input.amountMinor,
            currency: input.wallet.currency,
          },
        ],
      },
      input.postedBy,
    );

    const balances = await this.repository.recomputeFromLedger(tx, input.wallet);
    return { journalId: journal.id, balances };
  }

  // ==========================================================================
  // Holds
  // ==========================================================================

  /**
   * Moves funds into escrow against an obligation (docs/10 § 10.5).
   *
   * The caller must already hold the wallet's row lock — this method does not
   * take it, because the settlement path locks two wallets together in id
   * order and a nested lock here would break that ordering (ADR-031).
   *
   * Idempotent by construction rather than by check. The partial unique index
   * `uq_wallet_hold_active_reference` permits one live hold per
   * `(wallet, reference)`, so two concurrent retries of the same request both
   * pass the pre-flight read below and exactly one survives the insert. The
   * pre-flight exists only to return the existing hold instead of an error,
   * which is what a retrying client should see.
   */
  async placeHold(
    tx: ExtendedPrismaClient,
    input: {
      wallet: LockedWallet;
      amountMinor: bigint;
      reference: string;
      referenceType: string;
      transactionId: string;
      placedBy: string;
    },
  ): Promise<{ holdId: string; journalId: string | null; balances: Balances; replayed: boolean }> {
    const existing = await this.repository.findActiveHold(tx, input.wallet.id, input.reference);
    if (existing) {
      if (existing.amountMinor !== input.amountMinor) {
        // Same obligation, different amount. Refusing is the only safe answer:
        // silently keeping the old hold would under-secure the obligation, and
        // silently replacing it would move money on a request that looked like
        // a retry.
        throw RastaError.businessRule(
          'A hold already exists for this reference with a different amount',
          { walletId: input.wallet.id, reference: input.reference },
        );
      }
      return {
        holdId: existing.id,
        journalId: existing.placedJournalId,
        balances: balancesFrom(
          input.wallet.availableBalanceMinor,
          input.wallet.pendingBalanceMinor,
        ),
        replayed: true,
      };
    }

    if (input.wallet.status !== 'ACTIVE') {
      holdsRefusedTotal.inc({ service: SERVICE_NAME, reason: 'wallet_not_active' });
      throw RastaError.businessRule('This wallet cannot place new holds', {
        walletId: input.wallet.id,
        status: input.wallet.status,
      });
    }

    try {
      assertSufficient(
        input.wallet.id,
        balancesFrom(input.wallet.availableBalanceMinor, input.wallet.pendingBalanceMinor),
        input.amountMinor,
      );
    } catch (error) {
      holdsRefusedTotal.inc({ service: SERVICE_NAME, reason: 'insufficient_balance' });
      throw error;
    }

    const walletAccount = await this.ledger.resolveAccount(
      tx,
      'WALLET',
      input.wallet.organizationId,
      input.wallet.currency,
      input.placedBy,
    );
    const escrowAccount = await this.ledger.resolveAccount(
      tx,
      'ESCROW',
      input.wallet.organizationId,
      input.wallet.currency,
      input.placedBy,
    );

    const journal = await this.ledger.post(
      tx,
      {
        journalType: 'FUNDS_HELD',
        description: `Hold for ${input.referenceType} ${input.reference}`,
        organizationId: input.wallet.organizationId,
        transactionId: input.transactionId,
        entries: [
          {
            accountId: walletAccount.id,
            organizationId: walletAccount.organizationId,
            direction: 'DEBIT',
            amountMinor: input.amountMinor,
            currency: input.wallet.currency,
          },
          {
            accountId: escrowAccount.id,
            organizationId: escrowAccount.organizationId,
            direction: 'CREDIT',
            amountMinor: input.amountMinor,
            currency: input.wallet.currency,
          },
        ],
      },
      input.placedBy,
    );

    const holdId = `HLD_${ulid()}`;
    const placedAt = new Date();

    await this.repository.createHold(tx, {
      id: holdId,
      organizationId: input.wallet.organizationId,
      walletId: input.wallet.id,
      amountMinor: input.amountMinor,
      currency: input.wallet.currency,
      reference: input.reference,
      referenceType: input.referenceType,
      placedJournalId: journal.id,
      placedAt,
      placedBy: input.placedBy,
    });

    const balances = await this.repository.recomputeFromLedger(tx, input.wallet);

    await this.ledger.enqueue(tx, {
      eventName: ECONOMIC_EVENTS.FUNDS_HELD,
      aggregateId: holdId,
      organizationId: input.wallet.organizationId,
      payload: {
        holdId,
        walletId: input.wallet.id,
        organizationId: input.wallet.organizationId,
        transactionId: input.transactionId,
        reference: input.reference,
        referenceType: input.referenceType,
        amountMinor: formatMinor(input.amountMinor),
        currency: input.wallet.currency,
        heldAt: placedAt.toISOString(),
      },
    });

    return { holdId, journalId: journal.id, balances, replayed: false };
  }

  /**
   * Returns escrowed funds to the payer (docs/10 § 10.5, the cancel branch).
   *
   * The mirror of {@link placeHold}: escrow is debited, the wallet is credited,
   * and the hold becomes REFUNDED. It is a *new* journal rather than a reversal
   * of the hold journal, and the distinction is not cosmetic — a reversal says
   * "the hold should never have happened", while a refund says "it happened and
   * then the order was cancelled". The second is the truth, and an auditor
   * reading the ledger a year later needs to be able to tell them apart.
   */
  async refundHold(
    tx: ExtendedPrismaClient,
    input: {
      wallet: LockedWallet;
      holdId: string;
      transactionId: string;
      note: string;
      resolvedBy: string;
    },
  ): Promise<{ journalId: string; amountMinor: bigint; balances: Balances } | null> {
    const hold = await this.repository.findHoldById(tx, input.holdId);
    if (!hold) throw RastaError.notFound('WalletHold', input.holdId);
    // Already resolved — by a concurrent request, or by a retry of this one.
    // Reporting "nothing to do" rather than throwing keeps the caller
    // idempotent without it having to distinguish the two.
    if (hold.status !== 'ACTIVE') return null;

    const walletAccount = await this.ledger.resolveAccount(
      tx,
      'WALLET',
      input.wallet.organizationId,
      input.wallet.currency,
      input.resolvedBy,
    );
    const escrowAccount = await this.ledger.resolveAccount(
      tx,
      'ESCROW',
      input.wallet.organizationId,
      input.wallet.currency,
      input.resolvedBy,
    );

    const journal = await this.ledger.post(
      tx,
      {
        journalType: 'FUNDS_REFUNDED',
        description: `Refund of hold ${input.holdId}`,
        organizationId: input.wallet.organizationId,
        transactionId: input.transactionId,
        entries: [
          {
            accountId: escrowAccount.id,
            organizationId: escrowAccount.organizationId,
            direction: 'DEBIT',
            amountMinor: hold.amountMinor,
            currency: hold.currency,
          },
          {
            accountId: walletAccount.id,
            organizationId: walletAccount.organizationId,
            direction: 'CREDIT',
            amountMinor: hold.amountMinor,
            currency: hold.currency,
          },
        ],
      },
      input.resolvedBy,
    );

    const resolvedAt = new Date();
    const changed = await this.repository.resolveHold(tx, input.holdId, {
      status: 'REFUNDED',
      resolvedJournalId: journal.id,
      resolvedAt,
      resolvedBy: input.resolvedBy,
      resolutionNote: input.note,
    });

    if (changed === 0) {
      // Another transaction resolved it between the read and the update. The
      // journal above is part of this transaction, so throwing rolls it back
      // and nothing has moved twice.
      throw RastaError.optimisticLockFailed('WalletHold', input.holdId);
    }

    const balances = await this.repository.recomputeFromLedger(tx, input.wallet);

    await this.ledger.enqueue(tx, {
      eventName: ECONOMIC_EVENTS.FUNDS_RELEASED,
      aggregateId: input.holdId,
      organizationId: input.wallet.organizationId,
      payload: {
        holdId: input.holdId,
        walletId: input.wallet.id,
        organizationId: input.wallet.organizationId,
        transactionId: input.transactionId,
        reference: hold.reference,
        amountMinor: formatMinor(hold.amountMinor),
        currency: hold.currency,
        resolution: 'REFUNDED',
        resolvedAt: resolvedAt.toISOString(),
      },
    });

    return { journalId: journal.id, amountMinor: hold.amountMinor, balances };
  }

  /**
   * Marks a hold released as part of a settlement.
   *
   * No journal of its own: the settlement journal already debits the escrow
   * account, which is the movement. Posting a second one here would double the
   * effect — this only records that the hold is closed and announces it.
   */
  async markHoldReleased(
    tx: ExtendedPrismaClient,
    input: {
      hold: {
        id: string;
        walletId: string;
        organizationId: string;
        amountMinor: bigint;
        currency: string;
        reference: string;
      };
      settlementJournalId: string;
      transactionId: string;
      resolvedBy: string;
    },
  ): Promise<void> {
    const resolvedAt = new Date();
    const changed = await this.repository.resolveHold(tx, input.hold.id, {
      status: 'RELEASED',
      resolvedJournalId: input.settlementJournalId,
      resolvedAt,
      resolvedBy: input.resolvedBy,
      resolutionNote: 'Released by settlement',
    });

    if (changed === 0) {
      throw RastaError.optimisticLockFailed('WalletHold', input.hold.id);
    }

    await this.ledger.enqueue(tx, {
      eventName: ECONOMIC_EVENTS.FUNDS_RELEASED,
      aggregateId: input.hold.id,
      organizationId: input.hold.organizationId,
      payload: {
        holdId: input.hold.id,
        walletId: input.hold.walletId,
        organizationId: input.hold.organizationId,
        transactionId: input.transactionId,
        reference: input.hold.reference,
        amountMinor: formatMinor(input.hold.amountMinor),
        currency: input.hold.currency,
        resolution: 'RELEASED',
        resolvedAt: resolvedAt.toISOString(),
      },
    });
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  async getById(id: string) {
    const wallet = await this.repository.findById(id);
    if (!wallet) throw RastaError.notFound('Wallet', id);
    return wallet;
  }

  listHolds(walletId: string, status?: 'ACTIVE' | 'RELEASED' | 'REFUNDED') {
    return this.repository.listHolds(walletId, status);
  }

  /** Operational gauges. Cross-tenant by nature; no tenant ever sees them. */
  async sampleGauges(): Promise<void> {
    holdsActiveTotal.set({ service: SERVICE_NAME }, await this.repository.countActiveHolds());
  }
}
