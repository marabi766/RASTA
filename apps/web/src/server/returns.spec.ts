/**
 * @jest-environment node
 */
import { RETURN_REFUSAL_TEXT } from '@/lib/return-fields';
import {
  AUTHORIZED,
  BUYER,
  INSPECTED_SHIPMENT,
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
  assessShipments,
  cancelWithheldFor,
  goodsStateOf,
  isShipmentOfRequest,
  canReadReturns,
  canRequestReturn,
  fetchReturn,
  fetchReturnShipments,
  fetchReturns,
  fetchReturnsOfOrder,
  issueReturnCommand,
  issueReturnRequest,
  returnCallerOf,
  returnCommandsFor,
  returnableLines,
  sideOf,
} from './returns';
import type { WebSession } from './session';
import type { ReturnRequest, ReturnShipment } from './returns';

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
      expect(returnCommandsFor(caller(SUPPLIER, [role]), REQUESTED, 'NONE')).toEqual([
        'AUTHORIZE',
        'REJECT',
      ]);
    }
    for (const request of [AUTHORIZED, REJECTED, CANCELLED]) {
      expect(returnCommandsFor(caller(SUPPLIER, ['SUPPLIER']), request, 'NONE')).toEqual([]);
    }
    expect(returnCommandsFor(caller(SUPPLIER, ['PROCUREMENT_USER']), REQUESTED, 'NONE')).toEqual(
      [],
    );
  });

  it('the buyer withdraws a REQUESTED or AUTHORIZED one, and never decides', () => {
    const buyer = caller(BUYER, ['PROCUREMENT_USER']);
    expect(returnCommandsFor(buyer, REQUESTED, 'NONE')).toEqual(['CANCEL']);
    expect(returnCommandsFor(buyer, AUTHORIZED, 'NONE')).toEqual(['CANCEL']);
    expect(returnCommandsFor(buyer, REJECTED, 'NONE')).toEqual([]);
    expect(returnCommandsFor(buyer, CANCELLED, 'NONE')).toEqual([]);
    expect(returnCommandsFor(caller(BUYER, ['SUPPLIER']), REQUESTED, 'NONE')).toEqual([]);
  });

  it('nothing for a third organization, the auditor, or a token with no organization', () => {
    expect(returnCommandsFor(caller(STRANGER, ['ORGANIZATION_ADMIN']), REQUESTED, 'NONE')).toEqual(
      [],
    );
    expect(
      returnCommandsFor(caller(SUPPLIER, ['ORGANIZATION_ADMIN', 'AUDITOR']), REQUESTED, 'NONE'),
    ).toEqual([]);
    expect(returnCommandsFor(caller(null, ['SYSTEM_ADMIN']), REQUESTED, 'NONE')).toEqual([]);
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
  const all = (items: ReturnRequest[]) => ({ items, complete: true });

  it('sold, less what requests still holding units take; a refused or withdrawn one takes nothing', () => {
    expect(
      returnableLines(COMPLETED_ORDER, all([REQUESTED, { ...AUTHORIZED, id: 'RET_2' }])),
    ).toEqual([
      { orderLineId: LINE_A, available: 4 },
      { orderLineId: LINE_B, available: 20 },
    ]);
    expect(returnableLines(COMPLETED_ORDER, all([REJECTED, CANCELLED]))).toEqual([
      { orderLineId: LINE_A, available: 10 },
      { orderLineId: LINE_B, available: 20 },
    ]);
  });

  it('goods on the road, received or resolved were returned: their units are not returnable again', () => {
    for (const status of ['IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED', 'SOMETHING_NEW']) {
      expect(returnableLines(COMPLETED_ORDER, all([{ ...AUTHORIZED, status }]))[0]).toEqual({
        orderLineId: LINE_A,
        available: 7,
      });
    }
  });

  it('unknown when the requests could not be read, or not all of them', () => {
    expect(returnableLines(COMPLETED_ORDER, null).map((line) => line.available)).toEqual([
      null,
      null,
    ]);
    expect(
      returnableLines(COMPLETED_ORDER, { items: [REQUESTED], complete: false }).map(
        (line) => line.available,
      ),
    ).toEqual([null, null]);
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
      `http://gateway.test:3000/v1/return-shipments?returnRequestId=${RETURN_ID}&limit=50`,
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

/**
 * PR 336 review 1, finding 1: inventory-service lists any shipment that names
 * this request's id, whoever recorded it. Only one borne out by the request —
 * its supplier recorded it, from its buyer, for its order and its lines — is
 * the request's progress.
 */
describe('which listed shipments are this request’s goods', () => {
  const listed = (
    items: ReturnShipment[],
    complete = true,
  ): Parameters<typeof assessShipments>[1] => ({ kind: 'OK', data: { items, complete } });

  it('the supplier’s shipment of every authorized line is verified', () => {
    expect(isShipmentOfRequest(INSPECTED_SHIPMENT, AUTHORIZED)).toBe(true);
    expect(assessShipments(AUTHORIZED, listed([INSPECTED_SHIPMENT]))).toEqual({
      kind: 'KNOWN',
      verified: [INSPECTED_SHIPMENT],
      unverified: 0,
    });
  });

  it('a third organization’s shipment naming the buyer and the return id is not — and never shown as progress', () => {
    const forged: ReturnShipment = {
      ...INSPECTED_SHIPMENT,
      id: 'RSP_01JFORGEDAAAAAAAAAAAAAAAA',
      organizationId: STRANGER,
      carrierName: 'باربری جعلی',
    };
    expect(isShipmentOfRequest(forged, AUTHORIZED)).toBe(false);
    expect(assessShipments(AUTHORIZED, listed([forged]))).toEqual({
      kind: 'KNOWN',
      verified: [],
      unverified: 1,
    });
    expect(goodsStateOf(AUTHORIZED, assessShipments(AUTHORIZED, listed([forged])))).toBe('NONE');
  });

  it.each<[string, Partial<ReturnShipment>]>([
    ['another buyer named as the sender', { buyerOrganizationId: STRANGER }],
    ['another order', { orderId: 'ORD_01JOTHERAAAAAAAAAAAAAAAAA' }],
    ['another request', { returnRequestId: 'RET_01JOTHERAAAAAAAAAAAAAAAA' }],
    [
      'a line the request does not return',
      {
        lines: [
          { orderLineId: LINE_B, productId: 'PRD_B', expectedQuantity: 3, receivedQuantity: null },
        ],
      },
    ],
    [
      'another product on the request’s line',
      {
        lines: [
          { orderLineId: LINE_A, productId: 'PRD_B', expectedQuantity: 3, receivedQuantity: null },
        ],
      },
    ],
    [
      'more than was authorized',
      {
        lines: [
          { orderLineId: LINE_A, productId: 'PRD_A', expectedQuantity: 4, receivedQuantity: null },
        ],
      },
    ],
    [
      'less than was authorized, with nothing mirrored (partial dispatch cannot be known allowed)',
      {
        lines: [
          { orderLineId: LINE_A, productId: 'PRD_A', expectedQuantity: 2, receivedQuantity: null },
        ],
      },
    ],
    [
      'more received than dispatched',
      {
        lines: [
          { orderLineId: LINE_A, productId: 'PRD_A', expectedQuantity: 3, receivedQuantity: 4 },
        ],
      },
    ],
    [
      'a disposition of a line it does not carry',
      { dispositions: [{ orderLineId: LINE_B, disposition: 'SCRAP', quantity: 1 }] },
    ],
    [
      'more disposed of than received',
      { dispositions: [{ orderLineId: LINE_A, disposition: 'SCRAP', quantity: 4 }] },
    ],
  ])('not verified: %s', (_name, change) => {
    expect(isShipmentOfRequest({ ...INSPECTED_SHIPMENT, ...change }, AUTHORIZED)).toBe(false);
  });

  it('never for a request that was not authorized, or was withdrawn or refused', () => {
    for (const request of [REQUESTED, REJECTED, CANCELLED]) {
      expect(isShipmentOfRequest(INSPECTED_SHIPMENT, request)).toBe(false);
    }
  });

  it('once marketplace mirrored a shipment, only that one — and a partial one it checked is accepted', () => {
    const mirrored = {
      ...AUTHORIZED,
      status: 'RECEIVED',
      returnShipmentId: INSPECTED_SHIPMENT.id,
      lines: [...AUTHORIZED.lines, { orderLineId: LINE_B, productId: 'PRD_B', quantity: 5 }],
    };
    expect(isShipmentOfRequest(INSPECTED_SHIPMENT, mirrored)).toBe(true);
    expect(
      isShipmentOfRequest({ ...INSPECTED_SHIPMENT, id: 'RSP_01JOTHERAAAAAAAAAAAAAAAA' }, mirrored),
    ).toBe(false);
  });

  it('a refusal, a failure, or pages not read to their end is unknown, never "none"', () => {
    expect(assessShipments(AUTHORIZED, { kind: 'FORBIDDEN' })).toEqual({
      kind: 'UNKNOWN',
      reason: 'FORBIDDEN',
    });
    expect(
      assessShipments(AUTHORIZED, { kind: 'UNAVAILABLE', status: 503, correlationId: 'COR' }),
    ).toEqual({ kind: 'UNKNOWN', reason: 'UNAVAILABLE', correlationId: 'COR' });
    expect(assessShipments(AUTHORIZED, listed([], false))).toEqual({
      kind: 'UNKNOWN',
      reason: 'INCOMPLETE',
    });
  });
});

/**
 * PR 336 review 1, finding 2: with the mirror off, marketplace still says
 * AUTHORIZED after the goods left, and a withdrawal would release their units.
 */
describe('the withdrawal, against what the goods did', () => {
  const buyer = caller(BUYER, ['ORGANIZATION_ADMIN']);
  const known = (verified: ReturnShipment[]) =>
    ({ kind: 'KNOWN', verified, unverified: 0 }) as const;

  it('offered for an authorized request only while no goods of it are known to be moving', () => {
    const none = goodsStateOf(AUTHORIZED, known([]));
    expect(none).toBe('NONE');
    expect(returnCommandsFor(buyer, AUTHORIZED, none)).toEqual(['CANCEL']);
    expect(cancelWithheldFor(buyer, AUTHORIZED, none)).toBeNull();
  });

  it('withheld, and said why, once a verified shipment is listed', () => {
    const goods = goodsStateOf(AUTHORIZED, known([INSPECTED_SHIPMENT]));
    expect(goods).toBe('MOVING');
    expect(returnCommandsFor(buyer, AUTHORIZED, goods)).toEqual([]);
    expect(cancelWithheldFor(buyer, AUTHORIZED, goods)).toBe('MOVING');
  });

  it('withheld when the goods’ side is refused, unavailable or incomplete', () => {
    for (const reason of ['FORBIDDEN', 'UNAVAILABLE', 'INCOMPLETE'] as const) {
      const goods = goodsStateOf(AUTHORIZED, { kind: 'UNKNOWN', reason });
      expect(goods).toBe('UNKNOWN');
      expect(returnCommandsFor(buyer, AUTHORIZED, goods)).toEqual([]);
      expect(cancelWithheldFor(buyer, AUTHORIZED, goods)).toBe('UNKNOWN');
    }
  });

  it('withheld whatever inventory says once marketplace mirrored a shipment or a physical step', () => {
    for (const request of [
      { ...AUTHORIZED, returnShipmentId: INSPECTED_SHIPMENT.id },
      { ...AUTHORIZED, status: 'IN_TRANSIT', inTransitAt: '2026-10-08T08:00:00.000Z' },
    ]) {
      expect(goodsStateOf(request, known([]))).toBe('MOVING');
      expect(returnCommandsFor(buyer, request, goodsStateOf(request, known([])))).toEqual([]);
    }
  });

  it('a requested one stays withdrawable: no shipment can be its progress before authorization', () => {
    expect(goodsStateOf(REQUESTED, { kind: 'UNKNOWN', reason: 'FORBIDDEN' })).toBe('NONE');
    expect(returnCommandsFor(buyer, REQUESTED, 'NONE')).toEqual(['CANCEL']);
  });

  it('nothing is said to someone who could not withdraw it anyway', () => {
    expect(cancelWithheldFor(caller(SUPPLIER, ['SUPPLIER']), AUTHORIZED, 'MOVING')).toBeNull();
    expect(cancelWithheldFor(buyer, REJECTED, 'MOVING')).toBeNull();
  });
});

/** PR 336 review 1, findings 1 and 3: every page is followed before anything is concluded. */
describe('reading every page', () => {
  let urls: URL[];
  let pages: Record<string, unknown>;

  beforeEach(() => {
    urls = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
      const parsed = new URL(url);
      urls.push(parsed);
      const body = pages[parsed.searchParams.get('cursor') ?? 'first'];
      return new Response(JSON.stringify(body ?? { items: [], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr' },
      });
    }) as unknown as typeof fetch);
  });

  afterEach(() => jest.restoreAllMocks());

  const oneUnit = (index: number): ReturnRequest => ({
    ...REQUESTED,
    id: `RET_${String(index).padStart(26, '0')}`,
    lines: [{ orderLineId: LINE_A, productId: 'PRD_A', quantity: 1 }],
  });

  it('200 sold, 101 open one-unit requests over two pages: 99 left, not 100', async () => {
    const requests = Array.from({ length: 101 }, (_, index) => oneUnit(index));
    pages = {
      first: { items: requests.slice(0, 100), nextCursor: requests[99]!.id },
      [requests[99]!.id]: { items: requests.slice(100), nextCursor: null },
    };
    const order = {
      ...COMPLETED_ORDER,
      lines: [{ ...COMPLETED_ORDER.lines[0]!, quantity: 200, lineTotalMinor: '1780000000' }],
    };
    const result = await fetchReturnsOfOrder(SESSION, ORDER_ID, 'BUYER');
    expect(result).toMatchObject({ kind: 'OK', data: { complete: true } });
    expect(result.kind === 'OK' && result.data.items).toHaveLength(101);
    expect(urls.map((url) => url.searchParams.get('cursor'))).toEqual([null, requests[99]!.id]);
    expect(returnableLines(order, result.kind === 'OK' ? result.data : null)).toEqual([
      { orderLineId: LINE_A, available: 99 },
    ]);
  });

  it('a page that fails is the whole answer; pages past the bound are not a count', async () => {
    pages = { first: { items: [oneUnit(1)], nextCursor: 'NEXT' }, NEXT: { nope: true } };
    expect(await fetchReturnsOfOrder(SESSION, ORDER_ID, 'BUYER')).toMatchObject({
      kind: 'MALFORMED',
    });
    pages = { first: { items: [oneUnit(1)], nextCursor: 'first' } };
    const bounded = await fetchReturnsOfOrder(SESSION, ORDER_ID, 'BUYER', 3);
    expect(bounded).toMatchObject({ kind: 'OK', data: { complete: false } });
    expect(urls).toHaveLength(5);
    expect(
      returnableLines(COMPLETED_ORDER, bounded.kind === 'OK' ? bounded.data : null).every(
        (line) => line.available === null,
      ),
    ).toBe(true);
  });

  it('the verified shipment on a later page is found, the forged one on the first is not taken for it', async () => {
    const forged = {
      ...INSPECTED_SHIPMENT,
      id: 'RSP_01JFORGEDAAAAAAAAAAAAAAAA',
      organizationId: STRANGER,
    };
    pages = {
      first: { items: [forged], nextCursor: forged.id, hasMore: true },
      [forged.id]: { items: [INSPECTED_SHIPMENT], nextCursor: null, hasMore: false },
    };
    const listed = await fetchReturnShipments(SESSION, RETURN_ID);
    expect(urls.map((url) => url.searchParams.get('returnRequestId'))).toEqual([
      RETURN_ID,
      RETURN_ID,
    ]);
    expect(assessShipments(AUTHORIZED, listed)).toEqual({
      kind: 'KNOWN',
      verified: [INSPECTED_SHIPMENT],
      unverified: 1,
    });
  });
});
