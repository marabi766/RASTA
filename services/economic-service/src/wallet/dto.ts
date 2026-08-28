import { z } from 'zod';
import { amountMinorSchema, currencySchema } from '@rasta/contracts';

/** Wallet request and response shapes. */

export const walletQuerySchema = z
  .object({
    currency: currencySchema.default('IRR'),
  })
  .strict();

export type WalletQuery = z.infer<typeof walletQuerySchema>;

export const listHoldsQuerySchema = z
  .object({
    status: z.enum(['ACTIVE', 'RELEASED', 'REFUNDED']).optional(),
  })
  .strict();

export type ListHoldsQuery = z.infer<typeof listHoldsQuerySchema>;

export const placeHoldSchema = z
  .object({
    amountMinor: amountMinorSchema.refine((value) => BigInt(value) > 0n, {
      message: 'A hold must be positive',
    }),
    /**
     * The transaction the hold secures.
     *
     * Required rather than optional: a hold with no obligation behind it is
     * money removed from a wallet for no stated reason, and nothing would ever
     * release it. It is also the reference the partial unique index uses to
     * make a retried request idempotent.
     */
    transactionId: z.string().trim().min(1).max(64),
  })
  .strict();

export type PlaceHoldDto = z.infer<typeof placeHoldSchema>;

export interface WalletView {
  id: string;
  organizationId: string;
  currency: string;
  status: string;
  /**
   * Everything the platform owes this organization: spendable plus escrowed.
   *
   * Derived entirely from the ledger — the sum of the organization's wallet
   * and escrow account balances (ADR-034).
   */
  ledgerBalanceMinor: string;
  /** Committed to obligations and not yet settled. */
  pendingBalanceMinor: string;
  /** Spendable right now. Always `ledger − pending`, enforced in the database. */
  availableBalanceMinor: string;
  createdAt: string;
  updatedAt: string;
}

export interface WalletHoldView {
  id: string;
  walletId: string;
  amountMinor: string;
  currency: string;
  status: string;
  reference: string;
  referenceType: string;
  placedAt: string;
  placedBy: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}
