/**
 * @jest-environment node
 */
import { EMPTY_ORDER_COMMAND_FORM, type OrderCommandFormValues } from '@/lib/order-fields';

import {
  ORDER_COMMAND_TABLE,
  fetchOrder,
  fetchOrders,
  issueOrderCommand,
  orderCommandFormValues,
  parseOrderCommand,
} from './orders';
import type { WebSession } from './session';

/**
 * Reading orders and turning one form into one command's body.
 *
 * The cases that would be silent if wrong: an amount coerced to a `number`
 * and losing digits, a field posted to a command whose `.strict()` schema
 * refuses it, a blank optional field sent as `""`, and the money-releasing
 * command going through without the person saying they meant it.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'buyer',
  organizationId: 'ORG_BUYER',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
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

interface Seen {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function answering(body: unknown, status = 200) {
  const seen: Seen[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, seen };
}

function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

/** Past 2^53: a `number` could not hold it, and would not say so. */
const HUGE = '90071992547409931234';

const ORDER = {
  id: 'ORD_1',
  status: 'AWAITING_RECEIPT_CONFIRMATION',
  buyerOrganizationId: 'ORG_BUYER',
  supplierOrganizationId: 'ORG_SUPPLIER',
  totalAmountMinor: HUGE,
  currency: 'IRR',
  lines: [
    {
      offerId: 'OFR_1',
      productId: 'PRD_1',
      productName: 'فیلتر روغن',
      quantity: 2,
      unitPriceMinor: '45000000',
      lineTotalMinor: '90000000',
      currency: 'IRR',
      offerVersion: 3,
    },
  ],
  confirmedAt: '2026-09-20T08:00:00.000Z',
  fulfilledAt: '2026-09-21T08:00:00.000Z',
  receiptConfirmedAt: null,
  completedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  failureReason: null,
  createdAt: '2026-09-19T08:00:00.000Z',
  placedBy: 'USR_1',
  economicTransactionId: 'TX_1',
  availableActions: ['CONFIRM_RECEIPT', 'RAISE_DISPUTE', 'CANCEL'],
};

const values = (overrides: Partial<OrderCommandFormValues>): OrderCommandFormValues => ({
  ...EMPTY_ORDER_COMMAND_FORM,
  ...overrides,
});

// ---------------------------------------------------------------------------

describe('reading an order', () => {
  it('keeps an amount past 2^53 exactly, as the string it arrived as', async () => {
    const { impl } = answering(ORDER);
    const result = await withFetch(impl, () => fetchOrder(SESSION, 'ORD_1'));

    expect(result.kind === 'OK' && result.data.totalAmountMinor).toBe(HUGE);
    expect(typeof (result.kind === 'OK' && result.data.totalAmountMinor)).toBe('string');
  });

  it('refuses an amount that is not whole minor units, rather than rendering it', async () => {
    const { impl } = answering({ ...ORDER, totalAmountMinor: '12.5' });
    const result = await withFetch(impl, () => fetchOrder(SESSION, 'ORD_1'));
    expect(result.kind).toBe('MALFORMED');
  });

  it('keeps the available actions the service computed for this caller', async () => {
    const { impl } = answering(ORDER);
    const result = await withFetch(impl, () => fetchOrder(SESSION, 'ORD_1'));

    expect(result.kind === 'OK' && result.data.availableActions).toEqual([
      'CONFIRM_RECEIPT',
      'RAISE_DISPUTE',
      'CANCEL',
    ]);
  });

  it('drops an action it has no form for, rather than rendering an empty button', async () => {
    const { impl } = answering({ ...ORDER, availableActions: ['CONFIRM', 'TELEPORT'] });
    const result = await withFetch(impl, () => fetchOrder(SESSION, 'ORD_1'));
    expect(result.kind === 'OK' && result.data.availableActions).toEqual(['CONFIRM']);
  });

  it('offers nothing when an older service sends no actions at all', async () => {
    const older: Record<string, unknown> = { ...ORDER };
    delete older.availableActions;
    const { impl } = answering(older);
    const result = await withFetch(impl, () => fetchOrder(SESSION, 'ORD_1'));
    expect(result.kind === 'OK' && result.data.availableActions).toEqual([]);
  });

  it('keeps what the screens do not render out of the page', async () => {
    const { impl } = answering(ORDER);
    const result = await withFetch(impl, () => fetchOrder(SESSION, 'ORD_1'));
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('TX_1');
    expect(serialised).not.toContain('placedBy');
  });

  it('renders a non-party order as absent — the service says 404, not 403', async () => {
    const { impl } = answering({ code: 'NOT_FOUND' }, 404);
    await expect(withFetch(impl, () => fetchOrder(SESSION, 'ORD_9'))).resolves.toEqual({
      kind: 'NOT_FOUND',
    });
  });

  it('asks the list for one side, in the service’s own term', async () => {
    const { impl, seen } = answering({ items: [ORDER], nextCursor: null });
    await withFetch(impl, () => fetchOrders(SESSION, { role: 'SUPPLIER' }));
    expect(seen[0]!.url).toContain('role=SUPPLIER');
  });
});

// ---------------------------------------------------------------------------

describe('one form into one command body', () => {
  it('refuses a command the portal does not know', () => {
    expect(parseOrderCommand(values({ command: 'DELETE' }))).toEqual({
      ok: false,
      command: null,
      fieldErrors: {},
    });
  });

  it('sends only the fields the command’s strict schema accepts', () => {
    // A dispute reason left in the posted form must not reach `fulfill`,
    // whose schema would refuse it as unknown.
    const parsed = parseOrderCommand(
      values({ command: 'FULFILL', trackingReference: 'TRK-9', reason: 'stale field' }),
    );
    expect(parsed).toEqual({
      ok: true,
      request: { command: 'FULFILL', body: { trackingReference: 'TRK-9' } },
    });
  });

  it('omits a blank optional field instead of sending an empty string', () => {
    const parsed = parseOrderCommand(values({ command: 'FULFILL' }));
    expect(parsed).toEqual({ ok: true, request: { command: 'FULFILL', body: {} } });
  });

  it('refuses a dispute reason shorter than the service accepts, in Persian', () => {
    const parsed = parseOrderCommand(values({ command: 'RAISE_DISPUTE', reason: 'بد بود' }));
    expect(parsed).toMatchObject({ ok: false, fieldErrors: { reason: expect.any(String) } });
  });

  it('writes the limit in its message in Persian digits (L5-09)', () => {
    const parsed = parseOrderCommand(values({ command: 'RAISE_DISPUTE', reason: 'بد بود' }));
    expect(parsed).toMatchObject({
      ok: false,
      fieldErrors: { reason: expect.stringContaining('دست‌کم در ۱۰ نویسه') },
    });
    if (!parsed.ok) expect(parsed.fieldErrors.reason).not.toMatch(/[0-9]/);
  });

  it('refuses a dispute reason longer than the service accepts', () => {
    const parsed = parseOrderCommand(
      values({ command: 'RAISE_DISPUTE', reason: 'ا'.repeat(1001) }),
    );
    expect(parsed).toMatchObject({ ok: false, fieldErrors: { reason: expect.any(String) } });
  });

  it('turns a rating into the integer the service expects, Persian digits included', () => {
    const form = new FormData();
    form.set('command', 'REVIEW');
    form.set('rating', '۴');
    const parsed = parseOrderCommand(orderCommandFormValues(form));
    expect(parsed).toEqual({ ok: true, request: { command: 'REVIEW', body: { rating: 4 } } });
  });

  it('requires the operator to state responsibility — never inferred from the outcome', () => {
    const parsed = parseOrderCommand(
      values({
        command: 'RESOLVE_DISPUTE',
        outcome: 'REFUND',
        resolution: 'کالا تحویل نشده بود و فروشنده پاسخ نداد.',
        acknowledge: 'yes',
      }),
    );
    expect(parsed).toMatchObject({
      ok: false,
      fieldErrors: { responsibility: expect.any(String) },
    });
  });
});

describe('the commands that cannot be walked back', () => {
  it('will not confirm receipt unless the person said they meant it', () => {
    // The only command that releases money to the supplier (ADR-038). A
    // checkbox's `required` is a browser convenience; this is the check.
    const parsed = parseOrderCommand(values({ command: 'CONFIRM_RECEIPT' }));
    expect(parsed).toMatchObject({ ok: false, fieldErrors: { acknowledge: expect.any(String) } });
  });

  it('confirms receipt once acknowledged, and never sends the acknowledgement on', () => {
    const parsed = parseOrderCommand(values({ command: 'CONFIRM_RECEIPT', acknowledge: 'yes' }));
    expect(parsed).toEqual({ ok: true, request: { command: 'CONFIRM_RECEIPT', body: {} } });
  });

  it.each(['CANCEL', 'RESOLVE_DISPUTE'] as const)('requires it for %s too', (command) => {
    const parsed = parseOrderCommand(values({ command }));
    expect(parsed).toMatchObject({ ok: false, fieldErrors: { acknowledge: expect.any(String) } });
  });

  it('does not ask for it on a command that can be followed by another', () => {
    const parsed = parseOrderCommand(values({ command: 'CONFIRM' }));
    expect(parsed).toEqual({ ok: true, request: { command: 'CONFIRM', body: {} } });
  });
});

describe('issuing a command', () => {
  it('posts to the command’s own path with the submission id as the idempotency key', async () => {
    const { impl, seen } = answering({ id: 'ORD_1' });

    await withFetch(impl, () =>
      issueOrderCommand(
        SESSION,
        'ORD_1',
        { command: 'CONFIRM_RECEIPT', body: {} },
        'sub_aaaaaaaaaaaaaaaaaaaa',
      ),
    );

    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toContain('/v1/orders/ORD_1/confirm-receipt');
    expect(seen[0]!.headers['idempotency-key']).toBe('sub_aaaaaaaaaaaaaaaaaaaa');
  });

  it('has a path for every command', () => {
    expect(ORDER_COMMAND_TABLE.map((row) => row.path)).toEqual([
      'confirm',
      'fulfill',
      'confirm-receipt',
      'disputes',
      'disputes/resolve',
      'cancel',
      'reviews',
    ]);
  });

  it('reports a command the other party overtook as a sentence, not a failure', async () => {
    // Both parties can have the page open; the supplier may act first. The
    // service answers with a business rule, and it arrives as a message.
    const { impl } = answering(
      { code: 'BUSINESS_RULE_VIOLATION', message: 'Order ORD_1 cannot move from DISPUTED' },
      422,
    );
    const result = await withFetch(impl, () =>
      issueOrderCommand(
        SESSION,
        'ORD_1',
        { command: 'CONFIRM', body: {} },
        'sub_aaaaaaaaaaaaaaaaaaaa',
      ),
    );
    expect(result).toMatchObject({ kind: 'INVALID', message: expect.stringContaining('ORD_1') });
  });
});
