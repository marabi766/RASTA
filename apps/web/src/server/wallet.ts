import { z } from 'zod';
import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';
import { IRR, MoneyInputError, parseMoneyInput } from '@/lib/format';
import { TOP_UP_FIELDS, type TopUpFormField, type TopUpFormValues } from '@/lib/wallet-fields';
import type { WebSession } from './session';
import type { ReadResult } from './assets';

/**
 * Reading and topping up the organization wallet through the gateway
 * (ADR-058 § 3, ADR-059 § 3).
 *
 * Same shape as `assets.ts`/`maintenance.ts` for the reads. The one write —
 * top-up — exists because `economic-service` only ever credits a wallet
 * through the payment provider (`docs/06 § 6.10`); there is no endpoint that
 * conjures a balance, and this module does not pretend otherwise.
 *
 * **This MVP moves no real money** (`CLAUDE.md`, ADR-024). `provider()` below
 * reads the disclosure `economic-service` itself publishes — the UI shows
 * that sentence rather than writing its own, so the two can never disagree.
 */

const walletSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  currency: z.string(),
  status: z.string(),
  ledgerBalanceMinor: z.string(),
  pendingBalanceMinor: z.string(),
  availableBalanceMinor: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Wallet = z.infer<typeof walletSchema>;

const holdSchema = z.object({
  id: z.string(),
  walletId: z.string(),
  amountMinor: z.string(),
  currency: z.string(),
  status: z.string(),
  reference: z.string(),
  referenceType: z.string(),
  placedAt: z.string(),
  resolvedAt: z.string().nullable().default(null),
  resolutionNote: z.string().nullable().default(null),
});

export type WalletHold = z.infer<typeof holdSchema>;

const holdsPageSchema = z.object({
  items: z.array(holdSchema),
});

export type HoldsPage = z.infer<typeof holdsPageSchema>;

const transactionSchema = z.object({
  id: z.string(),
  transactionType: z.string(),
  status: z.string(),
  netAmountMinor: z.string(),
  currency: z.string(),
  occurredAt: z.string(),
  sourceType: z.string().nullable().default(null),
  sourceReference: z.string().nullable().default(null),
  disputeReason: z.string().nullable().default(null),
  settledAt: z.string().nullable().default(null),
  failureReason: z.string().nullable().default(null),
});

export type WalletTransaction = z.infer<typeof transactionSchema>;

const transactionPageSchema = z.object({
  items: z.array(transactionSchema),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

export type TransactionPage = z.infer<typeof transactionPageSchema>;

const providerSchema = z.object({
  provider: z.string(),
  simulated: z.boolean(),
  notice: z.string(),
});

export type PaymentProviderDisclosure = z.infer<typeof providerSchema>;

// Re-exported so a screen needs one import for both this module's results and
// `assets.ts`'s — the shape is identical, and only one module should define it.
export type { ReadResult };

async function read<S extends z.ZodTypeAny>(
  session: WebSession,
  path: string,
  schema: S,
): Promise<ReadResult<z.infer<S>>> {
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path,
      accessToken: session.accessToken,
    });

    const parsed = schema.safeParse(response.data);
    if (!parsed.success) return { kind: 'MALFORMED', correlationId: response.correlationId };
    return { kind: 'OK', data: parsed.data };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      if (error.status === 403) return { kind: 'FORBIDDEN' };
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

export function fetchWallet(session: WebSession, currency = 'IRR'): Promise<ReadResult<Wallet>> {
  return read(session, `/v1/wallets/me?currency=${encodeURIComponent(currency)}`, walletSchema);
}

export function fetchHolds(
  session: WebSession,
  walletId: string,
  status?: string,
): Promise<ReadResult<HoldsPage>> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  const query = params.toString();
  return read(
    session,
    `/v1/wallets/${encodeURIComponent(walletId)}/holds${query ? `?${query}` : ''}`,
    holdsPageSchema,
  );
}

export interface TransactionListQuery {
  readonly status?: string;
  readonly transactionType?: string;
  readonly cursor?: string;
}

/** How many rows one page shows. The service caps it far higher; this is a screen. */
export const TRANSACTIONS_PER_PAGE = 20;

export function fetchTransactions(
  session: WebSession,
  query: TransactionListQuery = {},
): Promise<ReadResult<TransactionPage>> {
  const params = new URLSearchParams({ limit: String(TRANSACTIONS_PER_PAGE) });
  if (query.status) params.set('status', query.status);
  if (query.transactionType) params.set('transactionType', query.transactionType);
  if (query.cursor) params.set('cursor', query.cursor);

  return read(session, `/v1/transactions?${params.toString()}`, transactionPageSchema);
}

export function fetchPaymentProvider(
  session: WebSession,
): Promise<ReadResult<PaymentProviderDisclosure>> {
  return read(session, '/v1/wallets/provider', providerSchema);
}

// ---------------------------------------------------------------------------
// Top-up — the one write in this module
// ---------------------------------------------------------------------------

const topUpResultSchema = z.object({
  paymentIntentId: z.string(),
  transactionId: z.string(),
  status: z.string(),
  amountMinor: z.string(),
  currency: z.string(),
  provider: z.string(),
  simulated: z.boolean(),
  failureReason: z.string().nullable().default(null),
});

export type TopUpResult = z.infer<typeof topUpResultSchema>;

export interface TopUpRequest {
  readonly amountMinor: string;
}

export const TOP_UP_FIELD_MAPPING: FieldMapping<TopUpFormField> = {
  paths: { amountMinor: 'amountMinor' },
  messages: {
    'A top-up must be positive': 'مبلغ باید بیشتر از صفر باشد',
    'Missing Idempotency-Key': 'درخواست دوباره ارسال شد؛ صفحه را تازه کنید',
  },
};

export function topUpFormValues(form: FormData): TopUpFormValues {
  const values: Record<TopUpFormField, string> = { amountMinor: '' };
  for (const field of TOP_UP_FIELDS) {
    const raw = form.get(field);
    values[field] = typeof raw === 'string' ? raw : '';
  }
  return values;
}

export type ParsedTopUpForm =
  | { readonly ok: true; readonly request: TopUpRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<TopUpFormField, string>> };

/**
 * Reads what a person typed the same way `MoneyField` would, without the
 * client component: `parseMoneyInput` accepts Persian, Arabic-Indic and Latin
 * digits and every grouping mark a keyboard or a paste produces, and never
 * produces a `number` — a rial amount routinely exceeds
 * `Number.MAX_SAFE_INTEGER`.
 */
export function parseTopUpForm(values: TopUpFormValues): ParsedTopUpForm {
  const raw = values.amountMinor.trim();
  if (raw === '') {
    return { ok: false, fieldErrors: { amountMinor: 'مبلغ را وارد کنید' } };
  }
  try {
    const minor = parseMoneyInput(raw, IRR);
    if (minor <= 0n) {
      return { ok: false, fieldErrors: { amountMinor: 'مبلغ باید بیشتر از صفر باشد' } };
    }
    return { ok: true, request: { amountMinor: minor.toString() } };
  } catch (cause) {
    if (cause instanceof MoneyInputError) {
      return { ok: false, fieldErrors: { amountMinor: cause.message } };
    }
    throw cause;
  }
}

export function topUpWallet(
  session: WebSession,
  walletId: string,
  request: TopUpRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<TopUpResult, TopUpFormField>> {
  return writeThroughGateway(session, {
    path: `/v1/wallets/${encodeURIComponent(walletId)}/top-up`,
    body: request,
    submissionId,
    schema: topUpResultSchema,
    mapping: TOP_UP_FIELD_MAPPING,
    fetchImpl,
  });
}
