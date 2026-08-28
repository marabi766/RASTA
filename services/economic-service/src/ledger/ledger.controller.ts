import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { LedgerService } from './ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletRepository } from '../wallet/wallet.repository';
import { assertNotAuditor, assertPlatformScope, canCommitOrganization } from '../access/access';
import {
  toAccountView,
  toEntryView,
  toJournalView,
  type AccountRow,
  type EntryRow,
  type JournalRow,
} from '../shared/views';
import {
  listEntriesQuerySchema,
  reverseJournalSchema,
  trialBalanceQuerySchema,
  type ListEntriesQuery,
  type ReverseJournalDto,
  type TrialBalanceQuery,
} from './dto';

/**
 * The ledger API (docs/06 § 6.10, docs/10 § 10.13).
 *
 * ## Three things this controller does not offer
 *
 * **No account creation.** Accounts are implied by the chart of accounts and
 * are created on first use through controlled paths. A chart anyone can extend
 * at runtime is a chart nobody can reconcile.
 *
 * **No journal creation.** A journal is always the record of something that
 * happened — a top-up, a hold, a settlement, a reward. An endpoint that posted
 * an arbitrary journal would let a caller move balances with no business fact
 * behind them, which is the one thing a ledger exists to make impossible.
 *
 * **No update and no delete.** The database refuses both
 * (`trg_ledger_entry_immutable`, `trg_journal_immutable`). The only correction
 * is a reversal, which is why that is the single write here.
 *
 * ## Why the trial balance is platform-scope
 *
 * A per-tenant slice of a double-entry ledger does **not** balance: a
 * settlement's counterparty leg and its commission leg belong to other
 * organizations. Serving a tenant a report called "trial balance" that never
 * balances would be worse than not serving one. docs/10 § 10.13 assigns it to
 * `UNION_ADMIN`, which is a Platform-scope role — so it is restricted, and it
 * says so.
 */
@ApiTags('ledger')
@Controller({ path: 'ledger', version: '1' })
export class LedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly prisma: PrismaService,
    private readonly wallets: WalletRepository,
  ) {}

  // ---- Accounts ------------------------------------------------------------

  @Get('accounts')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'This organization chart of accounts',
    description:
      'Two accounts per organization per currency: WALLET holds what can be spent, ESCROW ' +
      'what is committed to obligations (ADR-034). Platform accounts — commission revenue, ' +
      'reward expense, payment clearing — belong to the platform organization and are not ' +
      'listed here.',
  })
  async accounts() {
    assertNotAuditor();
    const rows = await this.ledger.listAccounts();
    return { items: rows.map((row) => toAccountView(row as AccountRow)) };
  }

  @Get('accounts/:id/entries')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'One account statement, newest first',
    description:
      'Cursor-paginated. Entries are append-only: nothing in this list can ever change, and a ' +
      'correction appears as a later reversal rather than as an edit.',
  })
  async entries(
    @Param('id') id: string,
    @Query(zodPipe(listEntriesQuerySchema)) query: ListEntriesQuery,
  ) {
    assertNotAuditor();
    const result = await this.ledger.listEntries(id, query.cursor, query.limit);
    return {
      items: result.items.map((row) => toEntryView(row as unknown as EntryRow)),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  // ---- Journals ------------------------------------------------------------

  @Get('journals/:id')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'One journal with every leg',
    description:
      'Returns 404 for a journal belonging to another organization. A journal that has been ' +
      'reversed is unchanged — the reversal is a separate journal whose `reversesId` points ' +
      'back here.',
  })
  async journal(@Param('id') id: string) {
    assertNotAuditor();
    const row = await this.ledger.getJournal(id);
    return toJournalView(row as unknown as JournalRow);
  }

  /**
   * Reverses a posted journal — the ledger's only correction (AGENTS.md A-06).
   *
   * Restricted to platform administrators. Reversing a journal changes what
   * two organizations' balances are, and it is the one operation in this
   * service that can undo a settlement's effect; putting it in the hands of a
   * single tenant's administrator would let one party unwind a movement the
   * other party relied on.
   *
   * The wallets touched by the original journal are recomputed from the ledger
   * in the same transaction, so the reversal and the balances it implies
   * commit together.
   */
  @Post('journals/:id/reverse')
  @HttpCode(201)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Reverse a posted journal',
    description:
      'Posts a new journal mirroring every leg in the opposite direction, returning the ' +
      'affected accounts to exactly the balances they had before — without changing a single ' +
      'row of history. A journal can be reversed at most once, enforced by a unique ' +
      'constraint rather than by a check two concurrent requests could both pass. It does not ' +
      'post the corrected journal: that is a separate, deliberate act.',
  })
  async reverse(
    @Param('id') id: string,
    @Body(zodPipe(reverseJournalSchema)) dto: ReverseJournalDto,
  ) {
    assertPlatformScope('Reversing a journal');

    return this.prisma.transaction(async (tx) => {
      const original = await this.ledger.getJournal(id);
      canCommitOrganization(original.organizationId);

      const reversal = await this.ledger.reverse(tx, id, dto.reason, 'platform-administrator');

      // Every wallet whose account appears in the reversal has to be brought
      // back into line with the ledger in the same transaction, or the two
      // disagree until the hourly reconciliation notices.
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

      return { journalId: reversal.id, reversesId: id, postedAt: reversal.postedAt.toISOString() };
    });
  }

  // ---- Trial balance -------------------------------------------------------

  @Get('trial-balance')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Every account balance, and the proof that debits equal credits',
    description:
      'Platform-wide by nature: a single organization slice of a double-entry ledger does not ' +
      'balance, because counterparty and commission legs belong elsewhere. `balanced: false` ' +
      'is a critical integrity alarm, not a report (docs/10 § 10.3).',
  })
  trialBalance(@Query(zodPipe(trialBalanceQuerySchema)) query: TrialBalanceQuery) {
    assertPlatformScope('The trial balance');
    return this.ledger.trialBalance(query.currency);
  }
}
