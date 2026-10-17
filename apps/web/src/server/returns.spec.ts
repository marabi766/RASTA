/**
 * @jest-environment node
 */
import { RETURN_REFUSAL_TEXT } from '@/lib/return-fields';
import {
  AUTHORIZED,
  BUYER,
  CANCELLED,
  COMPLETED_ORDER,
  LINE_A,
  LINE_B,
  ORDER_ID,
  REJECTED,
  REQUESTED,
  RETURN_ID,
  STRANGER,
  SUPPLIER,
  accessToken,
} from '@/test/return-fixtures';

import {
  canReadReturns,
  canRequestReturn,
  fetchReturn,
  fetchReturnShipments,
  fetchReturns,
  issueReturnCommand,
  issueReturnRequest,
  returnCallerOf,
  returnCommandsFor,
  returnableLines,
  sideOf,
} from './returns';
import type { WebSession } from './session';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SESSION = {
  subject: 'user-1',
  username: 'buyer',
  organizationId: BUYER,
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const caller = (organizationId: string | null, roles: readonly string[]) =>
  returnCallerOf(accessToken(organizationId, roles));

describe('who may ask for a return (mirrors POST /v1/orders/:id/returns)', () => {
  it('the buyer’s purchasing roles, of a completed order', () => {
    for (const role of ['ORGANIZATION_ADMIN', 'PROCUREMENT_USER', 'UNION_ADMIN', 'SYSTEM_ADMIN']) {
      expect([role, canRequestReturn(caller(BUYER, [role]), COMPLETED_ORDER)]).toEqual([
        role,
        true,
      ]);
    }
  });

  it('never the supplier, a stranger, a role that does not buy, or the auditor', () => {
    expect(canRequestReturn(caller(SUPPLIER, ['ORGANIZATION_ADMIN']), COMPLETED_ORDER)).toBe(false);
    expect(canRequestReturn(caller(STRANGER, ['ORGANIZATION_ADMIN']), COMPLETED_ORDER)).toBe(false);
    expect(canRequestReturn(caller(BUYER, ['SUPPLIER']), COMPLETED_ORDER)).toBe(false);
    expect(canRequestReturn(caller(BUYER, ['FLEET_MANAGER']), COMPLETED_ORDER)).toBe(false);
    expect(
      canRequestReturn(caller(BUYER, ['ORGANIZATION_ADMIN', 'AUDITOR']), COMPLETED_ORDER),
    ).toBe(false);
    // A token that acts for no organization is offered no write.
    expect(canRequestReturn(caller(null, ['SYSTEM_ADMIN']), COMPLETED_ORDER)).toBe(false);
  });

  it('never of an order that is not completed, or whose lines carry no id', () => {
    const buyer = caller(BUYER, ['ORGANIZATION_ADMIN']);
    for (const status of ['PENDING', 'FUNDS_HELD', 'FULFILLED', 'RECEIPT_CONFIRMED', 'CANCELLED']) {
      expect(canRequestReturn(buyer, { ...COMPLETED_ORDER, status })).toBe(false);
    }
    expect(canRequestReturn(buyer, { ...COMPLETED_ORDER, completedAt: null })).toBe(false);
    expect(
      canRequestReturn(buyer, {
        ...COMPLETED_ORDER,
        lines: COMPLETED_ORDER.lines.map((line) => ({ ...line, id: null })),
      }),
    ).toBe(false);
  });
});

describe('what may be done to a request (mirrors return-access.ts and the transitions)', () => {
  it('the supplier authorizes or rejects a REQUESTED one, and nothing after', () => {
    for (const role of ['SUPPLIER', 'ORGANIZATION_ADMIN', 'UNION_ADMIN', 'SYSTEM_ADMIN']) {
      expect(returnCommandsFor(caller(SUPPLIER, [role]), REQUESTED)).toEqual([
        'AUTHORIZE',
        'REJECT',
      ]);
    }
    for (const request of [AUTHORIZED, REJECTED, CANCELLED]) {
      expect(returnCommandsFor(caller(SUPPLIER, ['SUPPLIER']), request)).toEqual([]);
    }
    expect(returnCommandsFor(caller(SUPPLIER, ['PROCUREMENT_USER']), REQUESTED)).toEqual([]);
  });

  it('the buyer withdraws a REQUESTED or AUTHORIZED one, and never decides', () => {
    const buyer = caller(BUYER, ['PROCUREMENT_USER']);
    expect(returnCommandsFor(buyer, REQUESTED)).toEqual(['CANCEL']);
    expect(returnCommandsFor(buyer, AUTHORIZED)).toEqual(['CANCEL']);
    expect(returnCommandsFor(buyer, REJECTED)).toEqual([]);
    expect(returnCommandsFor(buyer, CANCELLED)).toEqual([]);
    expect(returnCommandsFor(caller(BUYER, ['SUPPLIER']), REQUESTED)).toEqual([]);
  });

  it('nothing for a third organization, the auditor, or a token with no organization', () => {
    expect(returnCommandsFor(caller(STRANGER, ['ORGANIZATION_ADMIN']), REQUESTED)).toEqual([]);
    expect(
      returnCommandsFor(caller(SUPPLIER, ['ORGANIZATION_ADMIN', 'AUDITOR']), REQUESTED),
    ).toEqual([]);
    expect(returnCommandsFor(caller(null, ['SYSTEM_ADMIN']), REQUESTED)).toEqual([]);
  });

  it('a side is the organization’s place in the order, nothing else', () => {
    expect(sideOf(caller(BUYER, ['ORGANIZATION_ADMIN']), COMPLETED_ORDER)).toBe('BUYER');
    expect(sideOf(caller(SUPPLIER, ['SUPPLIER']), COMPLETED_ORDER)).toBe('SUPPLIER');
    expect(sideOf(caller(STRANGER, ['SYSTEM_ADMIN']), COMPLETED_ORDER)).toBeNull();
  });

  it('the Returns link: every reading role, never the auditor or unreadable roles', () => {
    expect(canReadReturns(['SUPPLIER'])).toBe(true);
    expect(canReadReturns(['PROCUREMENT_USER'])).toBe(true);
    expect(canReadReturns(['FLEET_MANAGER'])).toBe(false);
    expect(canReadReturns(['ORGANIZATION_ADMIN', 'AUDITOR'])).toBe(false);
    expect(canReadReturns(null)).toBe(false);
  });
});

describe('what each line still allows', () => {
  it('sold, less what open requests take; a closed request takes nothing', () => {
    expect(returnableLines(COMPLETED_ORDER, [REQUESTED, { ...AUTHORIZED, id: 'RET_2' }])).toEqual([
      { orderLineId: LINE_A, available: 4 },
      { orderLineId: LINE_B, available: 20 },
    ]);
    expect(returnableLines(COMPLETED_ORDER, [REJECTED, CANCELLED])).toEqual([
      { orderLineId: LINE_A, available: 10 },
      { orderLineId: LINE_B, available: 20 },
    ]);
  });

  it('unknown when the requests could not be read — the service checks either way', () => {
    expect(returnableLines(COMPLETED_ORDER, null).map((line) => line.available)).toEqual([
      null,
      null,
    ]);
  });
});

describe('through the gateway', () => {
  let calls: { url: string; init: RequestInit }[];
  let answer: () => Response;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-1' },
    });

  const problem = (status: number, code: string, message: string, details?: unknown[]) =>
    json(status, { code, message, correlationId: 'corr-1', ...(details ? { details } : {}) });

  beforeEach(() => {
    calls = [];
    answer = () => json(200, { items: [], nextCursor: null });
    jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answer();
    }) as unknown as typeof fetch);
  });

  afterEach(() => jest.restoreAllMocks());

  it('lists one side, by status and order, and keeps no person', async () => {
    answer = () =>
      json(200, {
        items: [{ ...REQUESTED, requestedBy: 'USR-1', authorizedBy: null }],
        nextCursor: null,
      });
    const result = await fetchReturns(SESSION, { side: 'SUPPLIER', status: 'REQUESTED' });
    expect(new URL(calls[0]!.url).search).toBe('?role=SUPPLIER&limit=20&status=REQUESTED');
    expect(result.kind === 'OK' && result.data.items[0]).toEqual(REQUESTED);
    expect(JSON.stringify(result)).not.toContain('USR-1');
  });

  it('a request of a third organization is the same absence as one that does not exist', async () => {
    answer = () => problem(404, 'NOT_FOUND', 'ReturnRequest not found');
    expect(await fetchReturn(SESSION, RETURN_ID)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('the goods’ side: by return request, and a refusal is only about that side', async () => {
    answer = () => json(200, { items: [], nextCursor: null });
    await fetchReturnShipments(SESSION, RETURN_ID);
    expect(calls[0]!.url).toBe(
      `http://gateway.test:3000/v1/return-shipments?returnRequestId=${RETURN_ID}&limit=5`,
    );
    answer = () => problem(403, 'INSUFFICIENT_ROLE', 'Insufficient role');
    expect(await fetchReturnShipments(SESSION, RETURN_ID)).toEqual({ kind: 'FORBIDDEN' });
  });

  it('asks with exactly the body the DTO takes, under the submission id', async () => {
    answer = () => json(201, REQUESTED);
    const body = { reason: 'سه کیسه خیس رسید.', lines: [{ orderLineId: LINE_A, quantity: 3 }] };
    const result = await issueReturnRequest(SESSION, ORDER_ID, body, 'sub_KEYKEYKEYKEY');
    expect(result.kind).toBe('CREATED');
    expect(calls[0]!.url).toBe(`http://gateway.test:3000/v1/orders/${ORDER_ID}/returns`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(body);
    expect(new Headers(calls[0]!.init.headers).get('idempotency-key')).toBe('sub_KEYKEYKEYKEY');
  });

  it('decides with one word and withdraws with none', async () => {
    answer = () => json(200, AUTHORIZED);
    await issueReturnCommand(SESSION, RETURN_ID, 'REJECT', 'sub_KEYKEYKEYKEY');
    await issueReturnCommand(SESSION, RETURN_ID, 'CANCEL', 'sub_KEYKEYKEYKEY');
    expect(calls.map((call) => [call.url, JSON.parse(String(call.init.body))])).toEqual([
      [`http://gateway.test:3000/v1/returns/${RETURN_ID}/decisions`, { decision: 'REJECT' }],
      [`http://gateway.test:3000/v1/returns/${RETURN_ID}/cancellation`, {}],
    ]);
  });

  it('says each refusal in fixed words — window not configured (Q-132), elapsed, wrong state', async () => {
    const body = { reason: 'سه کیسه خیس رسید.', lines: [{ orderLineId: LINE_A, quantity: 3 }] };
    const cases: [string, string][] = [
      [
        'Returns are not open: no return window is configured (open question Q-132)',
        RETURN_REFUSAL_TEXT.WINDOW_NOT_CONFIGURED,
      ],
      [
        `The 30-day return window for order ${ORDER_ID} has elapsed`,
        RETURN_REFUSAL_TEXT.WINDOW_ELAPSED,
      ],
      [
        `Order line ${LINE_A} has 2 unit(s) left to return, 3 asked`,
        RETURN_REFUSAL_TEXT.QUANTITY_EXCEEDS,
      ],
    ];
    for (const [sentence, text] of cases) {
      answer = () => problem(422, 'BUSINESS_RULE_VIOLATION', sentence);
      const result = await issueReturnRequest(SESSION, ORDER_ID, body, 'sub_KEYKEYKEYKEY');
      expect(result).toMatchObject({ kind: 'INVALID', message: text });
      expect(JSON.stringify(result)).not.toContain(sentence);
    }
    answer = () =>
      problem(
        422,
        'BUSINESS_RULE_VIOLATION',
        `Return request ${RETURN_ID} is already CANCELLED and cannot change further`,
      );
    expect(
      await issueReturnCommand(SESSION, RETURN_ID, 'AUTHORIZE', 'sub_KEYKEYKEYKEY'),
    ).toMatchObject({ kind: 'INVALID', message: RETURN_REFUSAL_TEXT.WRONG_STATE });
  });

  it('puts a refused quantity on its line’s field', async () => {
    answer = () =>
      problem(400, 'VALIDATION_FAILED', 'Request validation failed', [
        { path: 'lines.1.quantity', code: 'too_big', message: 'Number must be less than …' },
      ]);
    const result = await issueReturnRequest(
      SESSION,
      ORDER_ID,
      {
        reason: 'سه کیسه خیس رسید.',
        lines: [
          { orderLineId: LINE_A, quantity: 3 },
          { orderLineId: LINE_B, quantity: 9 },
        ],
      },
      'sub_KEYKEYKEYKEY',
    );
    expect(result).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { [`quantity.${LINE_B}`]: RETURN_REFUSAL_TEXT.VALIDATION },
    });
  });

  it('a 5xx after sending is unconfirmed, never "nothing happened"', async () => {
    answer = () => problem(503, 'UPSTREAM_UNAVAILABLE', 'down');
    expect(await issueReturnCommand(SESSION, RETURN_ID, 'AUTHORIZE', 'sub_KEYKEYKEYKEY')).toEqual({
      kind: 'UNKNOWN_OUTCOME',
      correlationId: expect.any(String),
    });
  });
});
