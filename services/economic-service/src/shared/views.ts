import { formatMinor } from './money';
import type { JournalView, LedgerAccountView, LedgerEntryView } from '../ledger/dto';
import type { WalletHoldView, WalletView } from '../wallet/dto';
import type { TransactionDetailView, TransactionView } from '../transaction/dto';
import type { CommissionRuleView, CommissionView } from '../commission/dto';
import type { RewardBalanceView, RewardView } from '../reward/dto';
import type { PaymentIntentView } from '../payment/dto';

/**
 * Row-to-view mapping.
 *
 * Explicit whitelists rather than spreading the row, so a column added to the
 * schema is never published by accident — the difference between a considered
 * API and one that leaks whatever the last migration happened to add. In this
 * service that matters more than usual: several columns exist for the audit
 * trail and for reconciliation, and none of them belongs in a response.
 *
 * One conversion runs through every function here: **`bigint.toString()`, never
 * `Number(...)`.** Money crosses the wire as a string in minor units
 * (ADR-022), and a rial amount past 9.007e15 does not survive a JSON number.
 * The mapping layer is the last place that could get this wrong, which is why
 * it is the one place it is written.
 */

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export interface WalletRow {
  id: string;
  organizationId: string;
  currency: string;
  status: string;
  ledgerBalanceMinor: bigint;
  pendingBalanceMinor: bigint;
  availableBalanceMinor: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export function toWalletView(row: WalletRow): WalletView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    currency: row.currency,
    status: row.status,
    ledgerBalanceMinor: formatMinor(row.ledgerBalanceMinor),
    pendingBalanceMinor: formatMinor(row.pendingBalanceMinor),
    availableBalanceMinor: formatMinor(row.availableBalanceMinor),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface HoldRow {
  id: string;
  walletId: string;
  amountMinor: bigint;
  currency: string;
  status: string;
  reference: string;
  referenceType: string;
  placedAt: Date;
  placedBy: string;
  resolvedAt: Date | null;
  resolutionNote: string | null;
}

export function toHoldView(row: HoldRow): WalletHoldView {
  return {
    id: row.id,
    walletId: row.walletId,
    amountMinor: formatMinor(row.amountMinor),
    currency: row.currency,
    status: row.status,
    reference: row.reference,
    referenceType: row.referenceType,
    placedAt: row.placedAt.toISOString(),
    placedBy: row.placedBy,
    resolvedAt: iso(row.resolvedAt),
    resolutionNote: row.resolutionNote,
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface AccountRow {
  id: string;
  organizationId: string;
  accountType: string;
  accountCode: string;
  purpose: string;
  currency: string;
  status: string;
  title: string | null;
}

export function toAccountView(row: AccountRow): LedgerAccountView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    accountType: row.accountType,
    accountCode: row.accountCode,
    purpose: row.purpose,
    currency: row.currency,
    status: row.status,
    title: row.title,
  };
}

export interface EntryRow {
  id: string;
  journalId: string;
  accountId: string;
  direction: string;
  amountMinor: bigint;
  currency: string;
  postedAt: Date;
  journal: { journalType: string; description: string; transactionId: string | null };
}

export function toEntryView(row: EntryRow): LedgerEntryView {
  return {
    id: row.id,
    journalId: row.journalId,
    accountId: row.accountId,
    direction: row.direction,
    amountMinor: formatMinor(row.amountMinor),
    currency: row.currency,
    postedAt: row.postedAt.toISOString(),
    journalType: row.journal.journalType,
    description: row.journal.description,
    transactionId: row.journal.transactionId,
  };
}

export interface JournalRow {
  id: string;
  organizationId: string;
  transactionId: string | null;
  journalType: string;
  description: string;
  postedAt: Date;
  postedBy: string;
  reversesId: string | null;
  reversalReason: string | null;
  correlationId: string;
  entries: {
    id: string;
    accountId: string;
    organizationId: string;
    direction: string;
    amountMinor: bigint;
    currency: string;
  }[];
}

export function toJournalView(row: JournalRow): JournalView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    transactionId: row.transactionId,
    journalType: row.journalType,
    description: row.description,
    postedAt: row.postedAt.toISOString(),
    postedBy: row.postedBy,
    reversesId: row.reversesId,
    reversalReason: row.reversalReason,
    correlationId: row.correlationId,
    entries: row.entries.map((entry) => ({
      id: entry.id,
      accountId: entry.accountId,
      organizationId: entry.organizationId,
      direction: entry.direction,
      amountMinor: formatMinor(entry.amountMinor),
      currency: entry.currency,
    })),
  };
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

export interface TransactionRowLike {
  id: string;
  organizationId: string;
  counterpartyOrganizationId: string | null;
  transactionType: string;
  status: string;
  grossAmountMinor: bigint;
  commissionAmountMinor: bigint;
  netAmountMinor: bigint;
  currency: string;
  occurredAt: Date;
  sourceType: string | null;
  sourceReference: string | null;
  disputedAt: Date | null;
  disputeReason: string | null;
  settledAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  createdBy: string;
}

export function toTransactionView(row: TransactionRowLike): TransactionView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    counterpartyOrganizationId: row.counterpartyOrganizationId,
    transactionType: row.transactionType,
    status: row.status,
    grossAmountMinor: formatMinor(row.grossAmountMinor),
    commissionAmountMinor: formatMinor(row.commissionAmountMinor),
    netAmountMinor: formatMinor(row.netAmountMinor),
    currency: row.currency,
    occurredAt: row.occurredAt.toISOString(),
    sourceType: row.sourceType,
    sourceReference: row.sourceReference,
    disputedAt: iso(row.disputedAt),
    disputeReason: row.disputeReason,
    settledAt: iso(row.settledAt),
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
  };
}

export function toTransactionDetailView(
  row: TransactionRowLike & {
    legs: { organizationId: string; role: string; amountMinor: bigint; currency: string }[];
    commission: {
      id: string;
      ruleId: string | null;
      rateBasisPoints: number;
      amountMinor: bigint;
    } | null;
    settlement: { id: string; journalId: string; settledAt: Date } | null;
  },
): TransactionDetailView {
  return {
    ...toTransactionView(row),
    legs: row.legs.map((leg) => ({
      role: leg.role,
      organizationId: leg.organizationId,
      amountMinor: formatMinor(leg.amountMinor),
      currency: leg.currency,
    })),
    commission: row.commission
      ? {
          id: row.commission.id,
          ruleId: row.commission.ruleId,
          rateBasisPoints: row.commission.rateBasisPoints,
          amountMinor: formatMinor(row.commission.amountMinor),
        }
      : null,
    settlement: row.settlement
      ? {
          id: row.settlement.id,
          journalId: row.settlement.journalId,
          settledAt: row.settlement.settledAt.toISOString(),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Commission
// ---------------------------------------------------------------------------

export interface CommissionRuleRow {
  id: string;
  organizationId: string | null;
  transactionType: string;
  rateBasisPoints: number;
  minAmountMinor: bigint | null;
  maxAmountMinor: bigint | null;
  validFrom: Date;
  validTo: Date | null;
  status: string;
  label: string | null;
}

export function toCommissionRuleView(row: CommissionRuleRow): CommissionRuleView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    transactionType: row.transactionType,
    rateBasisPoints: row.rateBasisPoints,
    minAmountMinor: row.minAmountMinor === null ? null : formatMinor(row.minAmountMinor),
    maxAmountMinor: row.maxAmountMinor === null ? null : formatMinor(row.maxAmountMinor),
    validFrom: row.validFrom.toISOString(),
    validTo: iso(row.validTo),
    status: row.status,
    label: row.label,
  };
}

export interface CommissionRow {
  id: string;
  transactionId: string;
  organizationId: string;
  ruleId: string | null;
  rateBasisPoints: number;
  grossAmountMinor: bigint;
  amountMinor: bigint;
  currency: string;
  appliedAt: Date;
}

export function toCommissionView(row: CommissionRow): CommissionView {
  return {
    id: row.id,
    transactionId: row.transactionId,
    organizationId: row.organizationId,
    ruleId: row.ruleId,
    rateBasisPoints: row.rateBasisPoints,
    grossAmountMinor: formatMinor(row.grossAmountMinor),
    amountMinor: formatMinor(row.amountMinor),
    currency: row.currency,
    appliedAt: row.appliedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Reward
// ---------------------------------------------------------------------------

export interface RewardRow {
  id: string;
  organizationId: string;
  userId: string;
  ruleId: string;
  triggerEvent: string;
  sourceReference: string;
  points: number;
  creditAmountMinor: bigint;
  currency: string;
  monetised: boolean;
  journalId: string | null;
  grantedAt: Date;
}

export function toRewardView(row: RewardRow): RewardView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    ruleId: row.ruleId,
    triggerEvent: row.triggerEvent,
    sourceReference: row.sourceReference,
    points: row.points,
    creditAmountMinor: formatMinor(row.creditAmountMinor),
    currency: row.currency,
    monetised: row.monetised,
    journalId: row.journalId,
    grantedAt: row.grantedAt.toISOString(),
  };
}

export interface RewardBalanceRow {
  organizationId: string;
  userId: string;
  totalPoints: number;
  lifetimeCreditMinor: bigint;
  updatedAt: Date;
  level: { id: string; name: string; rank: number; minPoints: number } | null;
}

export function toRewardBalanceView(row: RewardBalanceRow): RewardBalanceView {
  return {
    organizationId: row.organizationId,
    userId: row.userId,
    totalPoints: row.totalPoints,
    level: row.level
      ? {
          id: row.level.id,
          name: row.level.name,
          rank: row.level.rank,
          minPoints: row.level.minPoints,
        }
      : null,
    lifetimeCreditMinor: formatMinor(row.lifetimeCreditMinor),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

export interface PaymentIntentRow {
  id: string;
  organizationId: string;
  walletId: string;
  transactionId: string | null;
  provider: string;
  simulated: boolean;
  amountMinor: bigint;
  currency: string;
  status: string;
  providerReference: string | null;
  failureReason: string | null;
  createdAt: Date;
  authorizedAt: Date | null;
  capturedAt: Date | null;
  failedAt: Date | null;
  refundedAt: Date | null;
}

export function toPaymentIntentView(row: PaymentIntentRow): PaymentIntentView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    walletId: row.walletId,
    transactionId: row.transactionId,
    provider: row.provider,
    simulated: row.simulated,
    amountMinor: formatMinor(row.amountMinor),
    currency: row.currency,
    status: row.status,
    providerReference: row.providerReference,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    authorizedAt: iso(row.authorizedAt),
    capturedAt: iso(row.capturedAt),
    failedAt: iso(row.failedAt),
    refundedAt: iso(row.refundedAt),
  };
}
