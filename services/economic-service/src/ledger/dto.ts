import { z } from 'zod';
import { currencySchema } from '@rasta/contracts';

/** Ledger read shapes, and the one write a caller may ask for: a reversal. */

export const listEntriesQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>;

export const trialBalanceQuerySchema = z
  .object({
    currency: currencySchema.default('IRR'),
  })
  .strict();

export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>;

export const reverseJournalSchema = z
  .object({
    /**
     * Required, and at least a sentence.
     *
     * A reversal is the only correction this ledger has (AGENTS.md A-06), and
     * the reason is stored on the reversing journal permanently. "fix" tells
     * an auditor nothing a year later, which is when they will read it.
     */
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();

export type ReverseJournalDto = z.infer<typeof reverseJournalSchema>;

export interface LedgerAccountView {
  id: string;
  organizationId: string;
  accountType: string;
  accountCode: string;
  purpose: string;
  currency: string;
  status: string;
  title: string | null;
}

export interface LedgerEntryView {
  id: string;
  journalId: string;
  accountId: string;
  direction: string;
  amountMinor: string;
  currency: string;
  postedAt: string;
  journalType: string;
  description: string;
  transactionId: string | null;
}

export interface JournalView {
  id: string;
  organizationId: string;
  transactionId: string | null;
  journalType: string;
  description: string;
  postedAt: string;
  postedBy: string;
  reversesId: string | null;
  reversalReason: string | null;
  correlationId: string;
  entries: {
    id: string;
    accountId: string;
    organizationId: string;
    direction: string;
    amountMinor: string;
    currency: string;
  }[];
}

export interface TrialBalanceView {
  currency: string;
  totalDebitMinor: string;
  totalCreditMinor: string;
  /** The proof. False is a critical alarm, not a report (docs/10 § 10.3). */
  balanced: boolean;
  accounts: {
    accountId: string;
    accountCode: string;
    accountType: string;
    organizationId: string;
    currency: string;
    debitMinor: string;
    creditMinor: string;
    /** In the account's natural direction, so a reader needs no sign convention. */
    balanceMinor: string;
  }[];
}
