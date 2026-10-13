/**
 * @jest-environment node
 */
import {
  PLACE_ORDER_FIELD_MAPPING,
  canPlaceOrder,
  parsePlaceOrderForm,
  placeOrder,
  placeOrderFormValues,
} from './place-order';
import { EMPTY_PLACE_ORDER_FORM } from '@/lib/place-order-fields';
import type { WebSession } from './session';

/**
 * Placing an order: the form into the body the service accepts, and every way
 * the service can answer back onto the form. The enforcement is the service's
 * (`place-order.contract.spec.ts` pins the copies); this file proves the portal
 * sends exactly what the service takes — no price, no extra field — and says
 * nothing it was not told.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SESSION = { accessToken: 'access-token-value' } as WebSession;
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const values = (fields: Partial<Record<'offerId' | 'quantity', string>>) => ({
  ...EMPTY_PLACE_ORDER_FORM,
  ...fields,
});

describe('who is offered the form', () => {
  it.each(['SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER'])(
    'offers it to %s',
    (role) => {
      expect(canPlaceOrder([role])).toBe(true);
    },
  );

  it.each(['SUPPLIER', 'FLEET_MANAGER', 'OPERATOR', 'DRIVER', 'AUDITOR'])(
    'does not offer it to %s',
    (role) => {
      expect(canPlaceOrder([role])).toBe(false);
    },
  );

  it('offers it to anybody holding any one admitted role, and to nobody with none', () => {
    expect(canPlaceOrder(['OPERATOR', 'PROCUREMENT_USER'])).toBe(true);
    expect(canPlaceOrder([])).toBe(false);
  });
});

describe('reading the form', () => {
  it('reads Persian digits in the quantity as the Latin ones the service wants', () => {
    expect(placeOrderFormValues(form({ offerId: 'OFR_1', quantity: '۱۲' })).quantity).toBe('12');
  });

  it('treats a missing field as blank, not as the string "null"', () => {
    expect(placeOrderFormValues(form({}))).toEqual(EMPTY_PLACE_ORDER_FORM);
  });
});

describe('parsing the form', () => {
  it('builds the one-line body and nothing else — no price, no organization', () => {
    const parsed = parsePlaceOrderForm(values({ offerId: 'OFR_1', quantity: '3' }));
    expect(parsed).toEqual({
      ok: true,
      request: { lines: [{ offerId: 'OFR_1', quantity: 3 }] },
    });
  });

  it.each(['OFR_‮1', 'OFR_‏1', 'OFR_\u00001', 'OFR_\n1'])(
    'refuses an offer id with a bidi or control character (%j)',
    (offerId) => {
      const parsed = parsePlaceOrderForm(values({ offerId, quantity: '1' }));
      expect(parsed).toEqual({ ok: false, fieldErrors: { offerId: 'پیشنهاد را انتخاب کنید' } });
    },
  );

  it.each([
    ['', 'quantity'],
    ['0', 'quantity'],
    ['-2', 'quantity'],
    ['1.5', 'quantity'],
    ['12a', 'quantity'],
    ['1000001', 'quantity'],
  ])('refuses a quantity of %p on the quantity field', (quantity, field) => {
    const parsed = parsePlaceOrderForm(values({ offerId: 'OFR_1', quantity }));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && Object.keys(parsed.fieldErrors)).toContain(field);
  });

  it('accepts the largest quantity the service accepts', () => {
    expect(parsePlaceOrderForm(values({ offerId: 'OFR_1', quantity: '1000000' })).ok).toBe(true);
  });

  it('asks for an offer when none is chosen', () => {
    const parsed = parsePlaceOrderForm(values({ quantity: '2' }));
    expect(parsed).toEqual({ ok: false, fieldErrors: { offerId: 'پیشنهاد را انتخاب کنید' } });
  });
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const REQUEST = { lines: [{ offerId: 'OFR_1', quantity: 3 }] };

function send(fetchImpl: jest.Mock) {
  return placeOrder(SESSION, REQUEST, SUBMISSION, fetchImpl as unknown as typeof fetch);
}

function problem(status: number, code: string, message: string, details?: unknown[]) {
  return jsonResponse(status, {
    code,
    message,
    correlationId: 'corr-1',
    ...(details ? { details } : {}),
  });
}

describe('what reaches the gateway', () => {
  it('posts the body to /v1/orders with the submission id as Idempotency-Key', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(201, { id: 'ORD_1', status: 'PENDING' }));
    const result = await send(fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://gateway.test:3000/v1/orders');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe(SUBMISSION);
    expect(JSON.parse(String(init.body))).toEqual(REQUEST);
    expect(result).toMatchObject({ kind: 'CREATED', data: { id: 'ORD_1' } });
  });

  it('sends the same key on a retry, so a retry is the service’s replay and not a second order', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(201, { id: 'ORD_1' }));
    await send(fetchImpl);
    await send(fetchImpl);
    const keys = fetchImpl.mock.calls.map(
      (args) => ((args as unknown[])[1] as RequestInit).headers as Record<string, string>,
    );
    expect(keys.map((h) => h['idempotency-key'])).toEqual([SUBMISSION, SUBMISSION]);
  });
});

describe('what the service can answer', () => {
  it('puts a named field’s problem back on that field', async () => {
    const result = await send(
      jest.fn(async () =>
        problem(400, 'VALIDATION_FAILED', 'Request validation failed', [
          { path: 'lines[0].quantity', code: 'too_small', message: 'Too small' },
        ]),
      ),
    );
    // Never the service's English: the code's closed Persian sentence.
    expect(result).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { quantity: PLACE_ORDER_FIELD_MAPPING.byCode?.VALIDATION_FAILED },
    });
    expect(JSON.stringify(result)).not.toContain('Too small');
  });

  it('never renders service text for a validation detail it has no path for (a bidi control)', async () => {
    const result = await send(
      jest.fn(async () =>
        problem(400, 'VALIDATION_FAILED', 'Request validation failed', [
          { path: 'lines[0].offerId', message: 'bad ‮ id' },
          { path: 'somewhere', code: 'weird', message: 'raw ‮ text' },
        ]),
      ),
    );
    expect(result.kind).toBe('INVALID');
    // Without the correlation id: a random UUID can contain "bad" by chance.
    const rendered = JSON.stringify(result, (key, value: unknown) =>
      key === 'correlationId' ? undefined : value,
    );
    expect(rendered).not.toMatch(/‮|raw|bad/i);
  });

  it('says a reused key with another body (IDEMPOTENCY_KEY_REUSED) in closed Persian', async () => {
    const result = await send(
      jest.fn(async () =>
        problem(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used'),
      ),
    );
    expect(result).toMatchObject({
      kind: 'INVALID',
      message: PLACE_ORDER_FIELD_MAPPING.byCode?.IDEMPOTENCY_KEY_REUSED,
    });
    expect(JSON.stringify(result)).not.toContain('Idempotency');
  });

  it('uses a fixed Persian fallback for a code it has no sentence for', async () => {
    const result = await send(jest.fn(async () => problem(422, 'SOMETHING_NEW', 'English text')));
    expect(result).toMatchObject({ kind: 'INVALID', message: PLACE_ORDER_FIELD_MAPPING.fallback });
    expect(JSON.stringify(result)).not.toContain('English');
  });

  it('translates the self-order refusal and says it in Persian', async () => {
    const result = await send(
      jest.fn(async () =>
        problem(422, 'BUSINESS_RULE_VIOLATION', 'An organization cannot order from itself'),
      ),
    );
    expect(result).toMatchObject({
      kind: 'INVALID',
      message: PLACE_ORDER_FIELD_MAPPING.messages?.['An organization cannot order from itself'],
    });
  });

  it('falls back by code for the minimum / available refusals, whose sentence carries ids and live numbers', async () => {
    const result = await send(
      jest.fn(async () => problem(422, 'BUSINESS_RULE_VIOLATION', 'Offer OFR_1 has 2 available')),
    );
    expect(result).toMatchObject({
      kind: 'INVALID',
      message: PLACE_ORDER_FIELD_MAPPING.byCode?.BUSINESS_RULE_VIOLATION,
    });
    // The service's English, with an id and a live quantity in it, is not shown.
    expect(JSON.stringify(result)).not.toContain('OFR_1');
  });

  it('says a reused key (409 without Retry-After) is an order already placed', async () => {
    const result = await send(
      jest.fn(async () =>
        problem(409, 'CONFLICT', 'An order has already been placed with this Idempotency-Key'),
      ),
    );
    expect(result).toMatchObject({
      kind: 'INVALID',
      message: PLACE_ORDER_FIELD_MAPPING.byCode?.CONFLICT,
    });
  });

  it('reads a 409 with Retry-After as still in progress, not as a refusal', async () => {
    const result = await send(
      jest.fn(async () =>
        jsonResponse(
          409,
          { code: 'CONFLICT', message: 'in flight', correlationId: 'corr-1' },
          { 'retry-after': '1' },
        ),
      ),
    );
    expect(result).toMatchObject({ kind: 'IN_PROGRESS' });
  });

  it('reads an offer that is absent or unpublished as not found', async () => {
    const result = await send(jest.fn(async () => problem(404, 'NOT_FOUND', 'Offer not found')));
    expect(result).toMatchObject({ kind: 'NOT_FOUND' });
  });

  it('reads 403 as forbidden', async () => {
    const result = await send(jest.fn(async () => problem(403, 'FORBIDDEN', 'no')));
    expect(result).toMatchObject({ kind: 'FORBIDDEN' });
  });

  it('reads a gateway timeout as an unknown outcome, never as "nothing was ordered"', async () => {
    const result = await send(jest.fn(async () => problem(504, 'UPSTREAM_TIMEOUT', 'timeout')));
    expect(result).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });

  it('reads a 2xx that is not an order as an unknown outcome', async () => {
    const result = await send(jest.fn(async () => jsonResponse(201, { nope: true })));
    expect(result).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });

  it.each([500, 502, 503])(
    'reads a %i as an unknown outcome — the order may have committed before it',
    async (status) => {
      const result = await send(jest.fn(async () => problem(status, 'INTERNAL_ERROR', 'down')));
      expect(result).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
    },
  );

  it('reads a failure with no problem body as an unknown outcome too', async () => {
    const result = await send(jest.fn(async () => new Response('<html>', { status: 502 })));
    expect(result).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });

  it('reads a dropped connection as an unknown outcome', async () => {
    const result = await send(
      jest.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(result).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });
});
