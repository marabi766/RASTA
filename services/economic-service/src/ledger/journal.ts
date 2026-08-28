import { RastaError } from '@rasta/nest-common';
import { opposite, signedValue } from '../shared/money';
import type { EntryDirection, JournalType } from '../generated/prisma';

/**
 * The rules of a journal, as pure functions.
 *
 * Nothing here touches a database or a request context, which is the point: a
 * balance check that needs a running PostgreSQL to exercise is a balance check
 * that gets tested once. These functions are the first line; the deferred
 * constraint trigger in the migration is the last one, and they deliberately
 * use the same arithmetic so the two cannot disagree about what "balanced"
 * means.
 */

/** One line of a journal, before it has an id. */
export interface DraftEntry {
  accountId: string;
  organizationId: string;
  direction: EntryDirection;
  amountMinor: bigint;
  currency: string;
}

/** A journal, before it has been posted. */
export interface DraftJournal {
  journalType: JournalType;
  description: string;
  organizationId: string;
  transactionId?: string | null;
  entries: DraftEntry[];
}

/**
 * The debit-minus-credit total per currency.
 *
 * A `Map` rather than a single number, because a journal that nets to zero only
 * by treating two currencies as interchangeable is not balanced — it is a
 * silent, unrated foreign-exchange transaction (docs/10 § 10.4). Phase one is
 * IRR-only, so this map has one key today; it is written this way so that the
 * day a second currency arrives, the check does not need revisiting.
 */
export function deltaByCurrency(entries: readonly DraftEntry[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const entry of entries) {
    const current = totals.get(entry.currency) ?? 0n;
    totals.set(entry.currency, current + signedValue(entry.direction, entry.amountMinor));
  }
  return totals;
}

/**
 * Refuses a journal that does not balance, or that is not double-entry.
 *
 * Four separate refusals, because they are four different mistakes:
 *
 *   - fewer than two entries is not double-entry bookkeeping at all;
 *   - a non-positive amount asserts nothing and balances nothing;
 *   - a non-zero delta in any currency is the classic unbalanced journal;
 *   - and each is reported with the figure, because "unbalanced" without the
 *     delta is a message that sends an operator to the database anyway.
 *
 * Throws `LEDGER_UNBALANCED` (422), the platform error code that exists for
 * exactly this (`packages/contracts/src/common/errors.ts`).
 */
export function assertBalanced(journalId: string, entries: readonly DraftEntry[]): void {
  if (entries.length < 2) {
    throw RastaError.ledgerUnbalanced(
      journalId,
      `journal has ${entries.length} entries; double-entry needs at least two`,
    );
  }

  for (const entry of entries) {
    if (entry.amountMinor <= 0n) {
      throw RastaError.ledgerUnbalanced(
        journalId,
        `entry on account ${entry.accountId} has a non-positive amount`,
      );
    }
  }

  for (const [currency, delta] of deltaByCurrency(entries)) {
    if (delta !== 0n) {
      throw RastaError.ledgerUnbalanced(journalId, `${currency}: ${delta.toString()}`);
    }
  }
}

/**
 * Builds the entries of a reversal journal.
 *
 * Every entry is mirrored: same account, same amount, opposite direction. That
 * is the whole mechanism, and its property is what ADR-013 requires — posting
 * a reversal returns every affected account to exactly the balance it had
 * before the original, **without changing a single row of history**
 * (AGENTS.md A-06).
 *
 * Note what this deliberately is *not*: it is not a "correction". Reversing a
 * wrong journal restores the previous state; posting the right journal is a
 * second, separate act. Combining them would produce one journal that both
 * undoes and redoes, and no reader could tell which part was the mistake
 * (docs/10 § 10.4).
 */
export function reverseEntries(entries: readonly DraftEntry[]): DraftEntry[] {
  return entries.map((entry) => ({
    accountId: entry.accountId,
    organizationId: entry.organizationId,
    direction: opposite(entry.direction),
    amountMinor: entry.amountMinor,
    currency: entry.currency,
  }));
}

/**
 * The single currency of a journal.
 *
 * Phase one is IRR-only and there is no exchange rate anywhere in this
 * platform, so a journal spanning two currencies would be an unrated
 * conversion. Refused here rather than allowed to balance per currency and
 * puzzle a reader later (docs/10 § 10.11: "بدون عملیات بین‌ارزی بدون نرخ صریح").
 */
export function singleCurrency(journalId: string, entries: readonly DraftEntry[]): string {
  const currencies = [...new Set(entries.map((entry) => entry.currency))];
  const [only] = currencies;
  if (currencies.length !== 1 || only === undefined) {
    throw RastaError.businessRule(
      'A journal cannot span currencies without an explicit exchange rate',
      { journalId, currencies },
    );
  }
  return only;
}
