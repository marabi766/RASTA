import { z } from 'zod';
import { amountMinorSchema, currencySchema } from '@rasta/contracts';
import type { AdapterDescriptor } from '../adapter';
import type { GatewayClient } from '../client';

/**
 * Payment-provider disclosure from `economic-service`.
 *
 * ADR-024 requires the simulated nature of MVP payments to be visible «در کد،
 * UI، مستند، Demo یا ارائه», and `GET /v1/wallets/provider` exists so a client
 * can state it without guessing. That is why this is an API call and not a
 * constant: a hard-coded «حالت نمایشی» becomes a lie the day a real provider
 * is configured, and the service's own contract suite asserts the inverse —
 * a live provider must stop repeating the simulated notice.
 *
 * Nothing here moves money, and nothing in this milestone does. The endpoint is
 * a `GET`, so the gateway's `Idempotency-Key` requirement on the `wallets`
 * prefix does not apply to it (it covers unsafe methods only).
 *
 * Route roles are `SYSTEM_ADMIN`, `UNION_ADMIN`, `ORGANIZATION_ADMIN`
 * (`wallet.controller.ts`), so a `PROCUREMENT_USER` gets `403` here. The UI
 * renders that as a "no access" state rather than an error — being refused is
 * the correct outcome for that role, not a fault.
 */

/** Mirrors `PaymentService.describeProvider()`. */
export const paymentProviderSchema = z.object({
  provider: z.string(),
  /** `true` while `MockPaymentProvider` is configured. No bank connection exists. */
  simulated: z.boolean(),
  notice: z.string(),
});

export type PaymentProviderDisclosure = z.infer<typeof paymentProviderSchema>;

export async function fetchPaymentProvider(
  client: GatewayClient,
  signal?: AbortSignal,
): Promise<PaymentProviderDisclosure> {
  const result = await client.request({
    path: '/v1/wallets/provider',
    schema: paymentProviderSchema,
    signal,
  });

  return result.data;
}

// ---------------------------------------------------------------------------
// Wallet, transactions and the ledger
// ---------------------------------------------------------------------------

/**
 * The economic reads this milestone shows.
 *
 * Kept separate from the provider disclosure above because the two answer
 * different questions and carry different route roles, and because a client
 * that can read a wallet is not necessarily one that can read the ledger:
 * `/v1/ledger` is restricted at the gateway to `SYSTEM_ADMIN` and
 * `UNION_ADMIN`, while the wallet routes also admit `ORGANIZATION_ADMIN`.
 *
 * Every amount is a decimal string of integer minor units, in and out. The
 * three balances are **not** recomputed here: `available = ledger − pending` is
 * enforced by a database constraint (ADR-034), and a browser subtracting them
 * again would be a second arithmetic that could disagree with the one that is
 * actually authoritative.
 */
export const ECONOMIC_WALLET_ADAPTER = {
  id: 'economic.wallet',
  service: 'economic-service',
  // The provider disclosure belongs here rather than in an adapter of its own:
  // it is read by the same screen, from the same service, and a registered
  // adapter that no capability names is dead code the integrity check would
  // still wave through.
  routes: ['GET /v1/wallets/me', 'GET /v1/wallets/provider', 'GET /v1/transactions'],
} as const satisfies AdapterDescriptor;

export const ECONOMIC_LEDGER_ADAPTER = {
  id: 'economic.ledger',
  service: 'economic-service',
  routes: ['GET /v1/ledger/accounts', 'GET /v1/ledger/trial-balance'],
} as const satisfies AdapterDescriptor;

export const walletViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  currency: currencySchema,
  status: z.string(),
  /** Everything the platform owes this organization: spendable plus escrowed. */
  ledgerBalanceMinor: amountMinorSchema,
  /** Committed to obligations and not yet settled. */
  pendingBalanceMinor: amountMinorSchema,
  /** Spendable now. Always `ledger − pending`, enforced in the database. */
  availableBalanceMinor: amountMinorSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WalletView = z.infer<typeof walletViewSchema>;

export const transactionViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  counterpartyOrganizationId: z.string().nullable(),
  transactionType: z.string(),
  status: z.string(),
  grossAmountMinor: amountMinorSchema,
  /** Deducted from the payee's net — never added on top of the buyer's total. */
  commissionAmountMinor: amountMinorSchema,
  netAmountMinor: amountMinorSchema,
  currency: currencySchema,
  occurredAt: z.string(),
  sourceType: z.string().nullable(),
  sourceReference: z.string().nullable(),
  disputedAt: z.string().nullable(),
  disputeReason: z.string().nullable(),
  settledAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string(),
});

export type TransactionView = z.infer<typeof transactionViewSchema>;

export const TRANSACTION_STATUS_LABELS: Record<string, string> = {
  CREATED: 'ایجادشده',
  HELD: 'وجه نگه‌داشته‌شده',
  PENDING_SETTLEMENT: 'در انتظار تسویه',
  SETTLED: 'تسویه‌شده',
  DISPUTED: 'در اعتراض',
  REFUNDED: 'مسترد',
  CANCELLED: 'لغوشده',
  FAILED: 'ناموفق',
};

export async function fetchWallet(
  client: GatewayClient,
  signal?: AbortSignal,
): Promise<WalletView> {
  const result = await client.request({
    path: '/v1/wallets/me',
    schema: walletViewSchema,
    signal,
  });

  return result.data;
}

export async function listTransactions(
  client: GatewayClient,
  options: { includeIncoming?: boolean } = {},
  signal?: AbortSignal,
): Promise<TransactionView[]> {
  const result = await client.request({
    path: '/v1/transactions',
    schema: z.object({
      items: z.array(transactionViewSchema),
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
    signal,
    query: {
      // Sent as the literal string on purpose. The service reads it through
      // `queryBoolean`, not `z.coerce.boolean()`, because the coercion made
      // `?includeIncoming=false` opt the caller *in* (D-023).
      includeIncoming:
        options.includeIncoming === undefined ? undefined : String(options.includeIncoming),
      limit: 50,
    },
  });

  return result.data.items;
}

export const ledgerAccountSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  accountType: z.string(),
  accountCode: z.string(),
  purpose: z.string(),
  currency: currencySchema,
  status: z.string(),
  title: z.string().nullable(),
});

export type LedgerAccount = z.infer<typeof ledgerAccountSchema>;

/**
 * The trial balance.
 *
 * `balanced` is the proof, not a report: `false` is a critical integrity alarm
 * (docs/10 § 10.3), and the UI renders it as one rather than as a neutral
 * field.
 *
 * Platform-wide by nature. A single organization's slice of a double-entry
 * ledger does not balance, because the counterparty and commission legs belong
 * elsewhere — which is why the route is restricted to `SYSTEM_ADMIN` and
 * `UNION_ADMIN` at the gateway *and* again inside the service.
 */
export const trialBalanceSchema = z.object({
  currency: currencySchema,
  totalDebitMinor: z.string(),
  totalCreditMinor: z.string(),
  balanced: z.boolean(),
  accounts: z.array(
    z.object({
      accountId: z.string(),
      accountCode: z.string(),
      accountType: z.string(),
      organizationId: z.string(),
      currency: currencySchema,
      debitMinor: z.string(),
      creditMinor: z.string(),
      /** In the account's natural direction, so no sign convention is needed. */
      balanceMinor: z.string(),
    }),
  ),
});

export type TrialBalance = z.infer<typeof trialBalanceSchema>;

/** `GET /v1/ledger/accounts` returns `{ items }` only — no cursor, no hasMore. */
export async function listLedgerAccounts(
  client: GatewayClient,
  signal?: AbortSignal,
): Promise<LedgerAccount[]> {
  const result = await client.request({
    path: '/v1/ledger/accounts',
    schema: z.object({ items: z.array(ledgerAccountSchema) }),
    signal,
  });

  return result.data.items;
}

export async function fetchTrialBalance(
  client: GatewayClient,
  signal?: AbortSignal,
): Promise<TrialBalance> {
  const result = await client.request({
    path: '/v1/ledger/trial-balance',
    schema: trialBalanceSchema,
    signal,
  });

  return result.data;
}
