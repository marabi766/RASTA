/**
 * @jest-environment node
 */
import {
  fetchHolds,
  fetchPaymentProvider,
  fetchTransactions,
  fetchWallet,
  parseTopUpForm,
  topUpFormValues,
  TOP_UP_FIELD_MAPPING,
} from './wallet';
import { EMPTY_TOP_UP_FORM } from '@/lib/wallet-fields';
import type { WebSession } from './session';

/**
 * Reading the wallet, and parsing the top-up form. Mirrors
 * `drivers.spec.ts`/`assets.spec.ts` for the reads and `usage.spec.ts` for
 * the write parsing — this module designs nothing new, so its tests do not
 * either.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'manager',
  organizationId: 'ORG_1',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
};

const ENV = {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
};

beforeEach(() => {
  Object.assign(process.env, ENV);
});

function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function answering(body: unknown, status = 200) {
  const urls: string[] = [];
  const impl = (async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, urls };
}

const WALLET = {
  id: 'WLT_1',
  organizationId: 'ORG_1',
  currency: 'IRR',
  status: 'ACTIVE',
  ledgerBalanceMinor: '1000000',
  pendingBalanceMinor: '200000',
  availableBalanceMinor: '800000',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('the wallet', () => {
  it('opens the caller’s own wallet, in the default currency', async () => {
    const { impl, urls } = answering(WALLET);
    const result = await withFetch(impl, () => fetchWallet(SESSION));
    expect(result.kind).toBe('OK');
    expect(new URL(urls[0]!).pathname).toBe('/v1/wallets/me');
    expect(new URL(urls[0]!).searchParams.get('currency')).toBe('IRR');
  });

  it('keeps the three balances, as strings', async () => {
    const { impl } = answering(WALLET);
    const result = await withFetch(impl, () => fetchWallet(SESSION));
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.data.availableBalanceMinor).toBe('800000');
    expect(typeof result.data.availableBalanceMinor).toBe('string');
  });

  it('separates a refusal from an outage', async () => {
    const forbidden = answering({}, 403);
    expect((await withFetch(forbidden.impl, () => fetchWallet(SESSION))).kind).toBe('FORBIDDEN');

    const broken = answering({}, 503);
    const result = await withFetch(broken.impl, () => fetchWallet(SESSION));
    expect(result.kind).toBe('UNAVAILABLE');
    if (result.kind === 'UNAVAILABLE') expect(result.status).toBe(503);
  });
});

describe('escrow holds', () => {
  it('reads via the wallet-scoped endpoint, encoding the id', async () => {
    const { impl, urls } = answering({ items: [] });
    await withFetch(impl, () => fetchHolds(SESSION, 'WLT/../secret'));
    expect(new URL(urls[0]!).pathname).toBe('/v1/wallets/WLT%2F..%2Fsecret/holds');
  });

  it('sends the status filter only when the caller set one', async () => {
    const { impl, urls } = answering({ items: [] });
    await withFetch(impl, () => fetchHolds(SESSION, 'WLT_1'));
    expect(new URL(urls[0]!).searchParams.has('status')).toBe(false);

    const { impl: impl2, urls: urls2 } = answering({ items: [] });
    await withFetch(impl2, () => fetchHolds(SESSION, 'WLT_1', 'ACTIVE'));
    expect(new URL(urls2[0]!).searchParams.get('status')).toBe('ACTIVE');
  });
});

describe('transaction history', () => {
  it('asks the gateway, with only the filters the caller set', async () => {
    const { impl, urls } = answering({ items: [], nextCursor: null, hasMore: false });
    await withFetch(impl, () => fetchTransactions(SESSION, { status: 'SETTLED' }));
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/v1/transactions');
    expect(url.searchParams.get('status')).toBe('SETTLED');
    expect(url.searchParams.get('limit')).toBe('20');
  });

  it('drops the audit actor and counterparty, keeps what the row shows', async () => {
    const { impl } = answering({
      items: [
        {
          id: 'TXN_1',
          transactionType: 'MARKETPLACE_ORDER',
          status: 'SETTLED',
          netAmountMinor: '900000',
          currency: 'IRR',
          occurredAt: '2026-02-01T00:00:00.000Z',
          sourceType: null,
          sourceReference: null,
          disputeReason: null,
          settledAt: '2026-02-02T00:00:00.000Z',
          failureReason: null,
          createdBy: 'USR_2',
          counterpartyOrganizationId: 'ORG_9',
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    const result = await withFetch(impl, () => fetchTransactions(SESSION));
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(JSON.stringify(result.data)).not.toContain('createdBy');
    expect(JSON.stringify(result.data)).not.toContain('counterpartyOrganizationId');
  });
});

describe('the payment provider disclosure', () => {
  it('reads it plainly, including the simulated flag', async () => {
    const { impl, urls } = answering({
      provider: 'mock',
      simulated: true,
      notice: 'Simulated payment provider. No bank connection, no real funds, no custody of money.',
    });
    const result = await withFetch(impl, () => fetchPaymentProvider(SESSION));
    expect(new URL(urls[0]!).pathname).toBe('/v1/wallets/provider');
    expect(result.kind).toBe('OK');
    if (result.kind === 'OK') expect(result.data.simulated).toBe(true);
  });
});

describe('topping up', () => {
  it('reads the amount as a string, defaulting an absent field to empty', () => {
    const form = new FormData();
    form.set('amountMinor', '1000000');
    expect(topUpFormValues(form)).toEqual({ amountMinor: '1000000' });
  });

  it('requires an amount', () => {
    const parsed = parseTopUpForm({ amountMinor: '' });
    expect(parsed).toMatchObject({ ok: false, fieldErrors: { amountMinor: 'مبلغ را وارد کنید' } });
  });

  it('parses Persian digits and grouping into plain minor units', () => {
    const parsed = parseTopUpForm({ amountMinor: '۱٬۰۰۰٬۰۰۰' });
    expect(parsed).toMatchObject({ ok: true, request: { amountMinor: '1000000' } });
  });

  it('refuses a zero or negative amount', () => {
    expect(parseTopUpForm({ amountMinor: '0' })).toMatchObject({
      ok: false,
      fieldErrors: { amountMinor: 'مبلغ باید بیشتر از صفر باشد' },
    });
  });

  it('refuses text that is not an amount, keeping what was typed as the error, not a crash', () => {
    const parsed = parseTopUpForm({ amountMinor: 'not a number' });
    expect(parsed.ok).toBe(false);
  });

  it('names a path for the one field the form posts', () => {
    for (const field of Object.keys(EMPTY_TOP_UP_FORM)) {
      expect(TOP_UP_FIELD_MAPPING.paths[field]).toBe(field);
    }
  });

  it('translates the positive-amount sentence wallet.controller.ts actually emits', () => {
    expect(TOP_UP_FIELD_MAPPING.messages?.['A top-up must be positive']).toBeDefined();
  });
});
