/**
 * @jest-environment node
 */
import { REPLAY_FIELD } from '@/lib/form-fields';
import {
  AMOUNT_FIELD,
  CONSIGNEE_FIELD,
  DIRECTION_FIELD,
  INVENTORY_COMMANDS,
  INVENTORY_REFUSAL_TEXT as TEXT,
  NAME_FIELD,
  ORDER_FIELD,
  PRODUCT_FIELD,
  QUANTITY_FIELD,
  SOURCE_FIELD,
  STOCK_ITEM_FIELD,
  legField,
  type InventoryScope,
} from '@/lib/inventory-commands';
import { CSRF_FIELD } from '@/server/csrf';
import { readFlash } from '@/server/flash';
import { mintInventoryStamp, type InventoryTarget } from '@/server/inventory-replay';
import type { WebSession } from '@/server/session';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';

import { IDLE_INVENTORY_FORM, type UnconfirmedInventory } from './inventory-form-state';

/**
 * The inventory commands' write path — the order of checks every portal write
 * keeps, then what each answer becomes, then the unconfirmed path: a retry
 * sends the same key and the same body, and nothing a retry is answered with
 * but a confirmation settles the first request. Against a fake
 * inventory-service behind the real gateway client, so what is asserted is
 * what would be sent.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const currentSession = jest.fn();
const missingSessionReason = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({
  currentSession: () => currentSession(),
  missingSessionReason: () => missingSessionReason(),
}));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));

const { submitInventoryCommand } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./inventory-actions') as typeof import('./inventory-actions');

const SESSION = {
  subject: 'user-1',
  username: 'operator',
  organizationId: 'ORG-DEH-0001',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const WAREHOUSE_ID = `WHS_${ULID}`;
const SHIPMENT_ID = `SHP_${ULID}`;
const ITEM_ID = `SKI_${ULID}`;
const PRODUCT_ID = `PRD_${ULID}`;
const CONSIGNEE = `ORG_${ULID}`;

const WAREHOUSES: InventoryScope = { kind: 'WAREHOUSES' };
const WAREHOUSE: InventoryScope = { kind: 'WAREHOUSE', warehouseId: WAREHOUSE_ID };
const SHIPMENT: InventoryScope = { kind: 'SHIPMENT', shipmentId: SHIPMENT_ID };

const NEW_WAREHOUSE: InventoryTarget = {
  command: 'CREATE_WAREHOUSE',
  scope: WAREHOUSES,
  expectedVersion: null,
};
const RECEIVE: InventoryTarget = {
  command: 'RECEIVE_STOCK',
  scope: WAREHOUSE,
  expectedVersion: null,
};
const ADJUST: InventoryTarget = {
  command: 'ADJUST_STOCK',
  scope: WAREHOUSE,
  expectedVersion: null,
};
const NEW_SHIPMENT: InventoryTarget = {
  command: 'CREATE_SHIPMENT',
  scope: WAREHOUSE,
  expectedVersion: null,
};
const DISPATCH: InventoryTarget = {
  command: 'DISPATCH_SHIPMENT',
  scope: SHIPMENT,
  expectedVersion: 1,
};
const DELIVER: InventoryTarget = {
  command: 'DELIVER_SHIPMENT',
  scope: SHIPMENT,
  expectedVersion: 2,
};

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly key: string | null;
  readonly body: unknown;
}

let sent: Sent[] = [];
let answer: () => Response;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': `corr-${sent.length}`,
      ...headers,
    },
  });
}

function problem(
  status: number,
  code: string,
  options: { detail?: string; headers?: Record<string, string> } = {},
) {
  return json(
    status,
    {
      code,
      message: 'An English sentence never shown',
      correlationId: `corr-${sent.length}`,
      ...(options.detail
        ? {
            details: [
              {
                path: 'stock',
                code: options.detail,
                message: 'Stock cannot be moved: never shown',
              },
            ],
          }
        : {}),
    },
    options.headers,
  );
}

function form(
  fields: Record<string, string>,
  target: InventoryTarget | null,
  options: { csrf?: string | null; submission?: string } = {},
): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) data.set(CSRF_FIELD, csrf);
  const submission = options.submission ?? mintSubmissionId(SESSION);
  data.set(SUBMISSION_FIELD, submission);
  if (target) data.set(REPLAY_FIELD, mintInventoryStamp(SESSION, target, submission).token);
  return data;
}

const WAREHOUSE_FIELDS = { [NAME_FIELD]: 'انبار مرکزی', latitude: '۳۵٫۷', longitude: '۵۱٫۴' };
const RECEIVE_FIELDS = {
  [PRODUCT_FIELD]: PRODUCT_ID,
  [QUANTITY_FIELD]: '۱۲۰',
  [SOURCE_FIELD]: `PO_${ULID}`,
};
const ADJUST_FIELDS = {
  [STOCK_ITEM_FIELD]: ITEM_ID,
  [DIRECTION_FIELD]: 'DECREASE',
  [AMOUNT_FIELD]: '۵',
};
const SHIPMENT_FIELDS = {
  [CONSIGNEE_FIELD]: CONSIGNEE,
  [ORDER_FIELD]: `ORD_${ULID}`,
  [legField(0, 'carrierName')]: 'باربری یک',
  [legField(0, 'carrierReference')]: 'WB-1',
  [legField(1, 'carrierName')]: '',
  [legField(2, 'carrierName')]: 'باربری دو',
};

const STOCK_CHANGE = {
  stockItem: { id: ITEM_ID, warehouseId: WAREHOUSE_ID },
  movement: { id: 'MOV_1' },
};

beforeEach(() => {
  sent = [];
  currentSession.mockResolvedValue(SESSION);
  missingSessionReason.mockResolvedValue('NO_SESSION');
  redirect.mockClear();
  answer = () => json(201, STOCK_CHANGE);
  jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : null;
    sent.push({
      url,
      method: init.method ?? 'GET',
      key: new Headers(init.headers).get('idempotency-key'),
      body,
    });
    return answer();
  }) as unknown as typeof fetch);
});

afterEach(() => jest.restoreAllMocks());

const run = (scope: InventoryScope, data: FormData, previous = IDLE_INVENTORY_FORM) =>
  submitInventoryCommand(scope, previous, data);

function landed(): URL {
  return new URL(redirect.mock.calls[0]![0], 'http://portal.test');
}

describe('the order of checks — nothing is sent until every one passes', () => {
  it('no session: ended, or only unavailable for now', async () => {
    currentSession.mockResolvedValue(null);
    expect(await run(WAREHOUSE, form({}, RECEIVE))).toEqual({
      kind: 'REFUSED',
      reason: 'NO_SESSION',
    });
    missingSessionReason.mockResolvedValue('SESSION_UNAVAILABLE');
    expect(await run(WAREHOUSE, form({}, RECEIVE))).toEqual({
      kind: 'REFUSED',
      reason: 'SESSION_UNAVAILABLE',
    });
    expect(sent).toHaveLength(0);
  });

  it('a missing CSRF token, a submission id this server did not mint', async () => {
    expect(await run(WAREHOUSE, form(RECEIVE_FIELDS, RECEIVE, { csrf: null }))).toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
    expect(
      await run(WAREHOUSE, form(RECEIVE_FIELDS, RECEIVE, { submission: 'sub_chosen_by_client' })),
    ).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    expect(sent).toHaveLength(0);
  });

  it('no stamp, a stamp for another warehouse or slot, a command the slot cannot hold', async () => {
    expect(await run(WAREHOUSE, form(RECEIVE_FIELDS, null))).toEqual({
      kind: 'REFUSED',
      reason: 'REPLAY',
    });
    const other: InventoryScope = { kind: 'WAREHOUSE', warehouseId: `WHS_${'A'.repeat(26)}` };
    expect(await run(other, form(RECEIVE_FIELDS, RECEIVE))).toEqual({
      kind: 'REFUSED',
      reason: 'REPLAY',
    });
    expect(await run(WAREHOUSES, form(RECEIVE_FIELDS, RECEIVE))).toEqual({
      kind: 'REFUSED',
      reason: 'REPLAY',
    });
    expect(await run(SHIPMENT, form({}, RECEIVE))).toEqual({ kind: 'REFUSED', reason: 'REPLAY' });
    // A move's stamp on a warehouse slot.
    expect(await run(WAREHOUSE, form({}, DISPATCH))).toEqual({
      kind: 'REFUSED',
      reason: 'REPLAY',
    });
    expect(sent).toHaveLength(0);
  });
});

describe('every command: its endpoint, one Idempotency-Key, its body, its landing', () => {
  it('create warehouse: POST /v1/warehouses, no organization in the body, to the new warehouse', async () => {
    answer = () => json(201, { id: WAREHOUSE_ID, status: 'ACTIVE' });
    const data = form({ ...WAREHOUSE_FIELDS, organizationId: 'ORG-OTHER' }, NEW_WAREHOUSE);
    await expect(run(WAREHOUSES, data)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toEqual([
      {
        url: 'http://gateway.test:3000/v1/warehouses',
        method: 'POST',
        key: data.get(SUBMISSION_FIELD),
        body: { name: 'انبار مرکزی', location: { latitude: 35.7, longitude: 51.4 } },
      },
    ]);
    const url = landed();
    expect(url.pathname + '?' + url.searchParams.get('warehouse')).toBe(
      `/inventory?${WAREHOUSE_ID}`,
    );
    expect(
      readFlash(SESSION, url.searchParams.get('flash'), WAREHOUSE_ID, INVENTORY_COMMANDS),
    ).toBe('CREATE_WAREHOUSE');
  });

  it('create warehouse without a location leaves the key out', async () => {
    answer = () => json(201, { id: WAREHOUSE_ID });
    await expect(run(WAREHOUSES, form({ [NAME_FIELD]: 'انبار' }, NEW_WAREHOUSE))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(sent[0]!.body).toEqual({ name: 'انبار' });
  });

  it('receive stock: POST /v1/stock/receipts into the slot’s warehouse — whatever the form posts', async () => {
    const data = form({ ...RECEIVE_FIELDS, warehouseId: `WHS_${'B'.repeat(26)}` }, RECEIVE);
    await expect(run(WAREHOUSE, data)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toEqual([
      {
        url: 'http://gateway.test:3000/v1/stock/receipts',
        method: 'POST',
        key: data.get(SUBMISSION_FIELD),
        body: {
          warehouseId: WAREHOUSE_ID,
          productId: PRODUCT_ID,
          quantity: 120,
          sourceReference: `PO_${ULID}`,
        },
      },
    ]);
    const url = landed();
    expect(url.searchParams.get('warehouse')).toBe(WAREHOUSE_ID);
    expect(
      readFlash(SESSION, url.searchParams.get('flash'), WAREHOUSE_ID, INVENTORY_COMMANDS),
    ).toBe('RECEIVE_STOCK');
  });

  it('adjust stock: POST /v1/stock/adjustments with a signed delta, no reason and no approval in the body', async () => {
    const data = form(ADJUST_FIELDS, ADJUST);
    await expect(run(WAREHOUSE, data)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toEqual([
      {
        url: 'http://gateway.test:3000/v1/stock/adjustments',
        method: 'POST',
        key: data.get(SUBMISSION_FIELD),
        body: { stockItemId: ITEM_ID, quantityDelta: -5 },
      },
    ]);
    const url = landed();
    expect(
      readFlash(SESSION, url.searchParams.get('flash'), WAREHOUSE_ID, INVENTORY_COMMANDS),
    ).toBe('ADJUST_STOCK');
  });

  it('adjust stock upward is a positive delta', async () => {
    await expect(
      run(WAREHOUSE, form({ ...ADJUST_FIELDS, [DIRECTION_FIELD]: 'INCREASE' }, ADJUST)),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(sent[0]!.body).toEqual({ stockItemId: ITEM_ID, quantityDelta: 5 });
  });

  it('create shipment: POST /v1/shipments out of the slot’s warehouse, blank legs dropped, to the shipment', async () => {
    answer = () => json(201, { id: SHIPMENT_ID, status: 'CREATED' });
    const data = form(SHIPMENT_FIELDS, NEW_SHIPMENT);
    await expect(run(WAREHOUSE, data)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toEqual([
      {
        url: 'http://gateway.test:3000/v1/shipments',
        method: 'POST',
        key: data.get(SUBMISSION_FIELD),
        body: {
          originWarehouseId: WAREHOUSE_ID,
          consigneeOrganizationId: CONSIGNEE,
          orderReference: `ORD_${ULID}`,
          legs: [
            { carrierName: 'باربری یک', carrierReference: 'WB-1' },
            { carrierName: 'باربری دو' },
          ],
        },
      },
    ]);
    const url = landed();
    expect(url.pathname).toBe(`/inventory/shipments/${SHIPMENT_ID}`);
    expect(readFlash(SESSION, url.searchParams.get('flash'), SHIPMENT_ID, INVENTORY_COMMANDS)).toBe(
      'CREATE_SHIPMENT',
    );
  });

  it.each([
    ['dispatch', DISPATCH, 1, 'DISPATCH_SHIPMENT'],
    ['deliver', DELIVER, 2, 'DELIVER_SHIPMENT'],
  ] as const)(
    '%s: POST …/{verb} with the version the page signed — whatever the form posts',
    async (verb, target, version, command) => {
      answer = () => json(200, { id: SHIPMENT_ID, status: 'DISPATCHED' });
      const data = form({ expectedVersion: '99', command: 'DELIVER_SHIPMENT' }, target);
      await expect(run(SHIPMENT, data)).rejects.toThrow('NEXT_REDIRECT');
      expect(sent).toEqual([
        {
          url: `http://gateway.test:3000/v1/shipments/${SHIPMENT_ID}/${verb}`,
          method: 'POST',
          key: data.get(SUBMISSION_FIELD),
          body: { expectedVersion: version },
        },
      ]);
      const url = landed();
      expect(url.pathname).toBe(`/inventory/shipments/${SHIPMENT_ID}`);
      expect(
        readFlash(SESSION, url.searchParams.get('flash'), SHIPMENT_ID, INVENTORY_COMMANDS),
      ).toBe(command);
    },
  );
});

describe('a form the portal can read is refused before anything is sent, the values kept', () => {
  it.each([
    ['a warehouse with no name', WAREHOUSES, NEW_WAREHOUSE, {}, NAME_FIELD],
    [
      'a receipt of zero',
      WAREHOUSE,
      RECEIVE,
      { ...RECEIVE_FIELDS, [QUANTITY_FIELD]: '0' },
      QUANTITY_FIELD,
    ],
    [
      'an adjustment with no direction',
      WAREHOUSE,
      ADJUST,
      { ...ADJUST_FIELDS, [DIRECTION_FIELD]: '' },
      DIRECTION_FIELD,
    ],
    [
      'a shipment to a malformed consignee',
      WAREHOUSE,
      NEW_SHIPMENT,
      { ...SHIPMENT_FIELDS, [CONSIGNEE_FIELD]: 'someone' },
      CONSIGNEE_FIELD,
    ],
  ] as const)('%s', async (_name, scope, target, fields, errorField) => {
    const state = await run(scope, form(fields, target));
    expect(state).toMatchObject({
      kind: 'INVALID',
      command: target.command,
      fieldErrors: { [errorField]: expect.any(String) },
      values: expect.any(Object),
    });
    expect(sent).toHaveLength(0);
  });
});

describe('what each documented refusal becomes — in fixed words, never the service’s sentence', () => {
  const cases: readonly (readonly [string, () => Response, string])[] = [
    [
      'adjustment below what is reserved',
      () => problem(422, 'BUSINESS_RULE_VIOLATION', { detail: 'ON_HAND_WOULD_BE_NEGATIVE' }),
      TEXT.ON_HAND_WOULD_BE_NEGATIVE,
    ],
    [
      'a balance past the largest stored',
      () => problem(422, 'BUSINESS_RULE_VIOLATION', { detail: 'QUANTITY_OUT_OF_RANGE' }),
      TEXT.QUANTITY_OUT_OF_RANGE,
    ],
    ['another rule', () => problem(422, 'BUSINESS_RULE_VIOLATION'), TEXT.OTHER_RULE],
    [
      'already dispatched',
      () => problem(409, 'INVALID_STATE_TRANSITION', { detail: 'SHIPMENT_NOT_CREATED' }),
      TEXT.SHIPMENT_NOT_CREATED,
    ],
    [
      'not dispatched yet',
      () => problem(409, 'INVALID_STATE_TRANSITION', { detail: 'SHIPMENT_NOT_DISPATCHED' }),
      TEXT.SHIPMENT_NOT_DISPATCHED,
    ],
    [
      'a state with no closed reason',
      () => problem(409, 'INVALID_STATE_TRANSITION'),
      TEXT.WRONG_STATE,
    ],
    ['a version that moved', () => problem(409, 'OPTIMISTIC_LOCK_FAILED'), TEXT.CHANGED],
    ['a key used for another body', () => problem(409, 'IDEMPOTENCY_KEY_REUSED'), TEXT.KEY_REUSED],
    ['a conflict that no wait changes', () => problem(409, 'CONFLICT'), TEXT.ALREADY_FILED],
    ['a body the service refuses', () => problem(400, 'VALIDATION_FAILED'), TEXT.VALIDATION],
  ];

  it.each(cases)('%s', async (_name, response, text) => {
    answer = response;
    const state = await run(WAREHOUSE, form(ADJUST_FIELDS, ADJUST));
    expect(state).toMatchObject({ kind: 'INVALID', command: 'ADJUST_STOCK' });
    expect(JSON.stringify(state)).toContain(text);
    expect(JSON.stringify(state)).not.toContain('English sentence');
    expect(JSON.stringify(state)).not.toContain('never shown');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('a refusal of the third leg lands on the third leg’s own field, in the body’s numbering', async () => {
    answer = () =>
      json(400, {
        code: 'VALIDATION_FAILED',
        message: 'x',
        correlationId: 'c',
        details: [{ path: 'legs.1.carrierName', message: 'Too long' }],
      });
    const state = await run(WAREHOUSE, form(SHIPMENT_FIELDS, NEW_SHIPMENT));
    // Two legs were sent (the blank one dropped), numbered 0 and 1: the refusal of
    // `legs.1` is the second sent leg, which the form is drawn again with as leg 1.
    expect(state).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { [legField(1, 'carrierName')]: TEXT.VALIDATION },
      values: { [legField(1, 'carrierName')]: 'باربری دو' },
    });
  });

  it('a refused caller (403) and a warehouse or shipment not theirs (404)', async () => {
    answer = () => problem(403, 'INSUFFICIENT_ROLE');
    expect(await run(WAREHOUSE, form(RECEIVE_FIELDS, RECEIVE))).toEqual({
      kind: 'FORBIDDEN',
      correlationId: expect.any(String),
    });
    answer = () => problem(404, 'NOT_FOUND');
    expect(await run(WAREHOUSE, form(RECEIVE_FIELDS, RECEIVE))).toEqual({ kind: 'NOT_FOUND' });
  });
});

describe('sent and not confirmed', () => {
  const unavailable = () => problem(503, 'SERVICE_UNAVAILABLE');
  const inFlight = () => problem(409, 'CONFLICT', { headers: { 'retry-after': '1' } });
  const timedOut = () => problem(504, 'UPSTREAM_TIMEOUT');

  async function unconfirmed(
    scope: InventoryScope,
    fields: Record<string, string>,
    target: InventoryTarget,
    response = unavailable,
  ): Promise<{ state: UnconfirmedInventory; data: FormData }> {
    answer = response;
    const data = form(fields, target);
    const state = (await run(scope, data)) as UnconfirmedInventory;
    return { state, data };
  }

  /** The unconfirmed view's form: the kept body, the kept key, the kept stamp. */
  function retryForm(state: UnconfirmedInventory, values: Record<string, string> = {}): FormData {
    const data = new FormData();
    data.set(CSRF_FIELD, SESSION.csrfToken);
    data.set(SUBMISSION_FIELD, state.submissionId);
    data.set(REPLAY_FIELD, state.replay?.token ?? '');
    for (const [name, value] of Object.entries(values)) data.set(name, value);
    return data;
  }

  it.each([
    ['a 503', unavailable],
    ['a 504 from the gateway', timedOut],
    ['a request still being processed (409 with Retry-After)', inFlight],
  ])('%s is unconfirmed, never "nothing changed"', async (_name, response) => {
    const { state, data } = await unconfirmed(WAREHOUSE, RECEIVE_FIELDS, RECEIVE, response);
    expect(state).toMatchObject({
      kind: 'UNCONFIRMED',
      command: 'RECEIVE_STOCK',
      submissionId: data.get(SUBMISSION_FIELD),
      body: { productId: PRODUCT_ID, quantity: 120, sourceReference: `PO_${ULID}` },
      replay: { token: data.get(REPLAY_FIELD) },
    });
  });

  it('a transport failure is unconfirmed too', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const state = await run(WAREHOUSE, form(RECEIVE_FIELDS, RECEIVE));
    expect(state).toMatchObject({ kind: 'UNCONFIRMED', command: 'RECEIVE_STOCK' });
  });

  it('a retry of a receipt is the same key and the same body — and moves stock once', async () => {
    const { state } = await unconfirmed(WAREHOUSE, RECEIVE_FIELDS, RECEIVE);
    answer = () => json(201, STOCK_CHANGE);
    // The view re-posts what it kept (`valuesOfBody`); a changed field would be a new request.
    const retry = retryForm(state, {
      [PRODUCT_FIELD]: PRODUCT_ID,
      [QUANTITY_FIELD]: '120',
      [SOURCE_FIELD]: `PO_${ULID}`,
    });
    await expect(run(WAREHOUSE, retry, state)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.key).toBe(sent[0]!.key);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
  });

  it('a retry of an adjustment and of a shipment is the same request', async () => {
    const adjust = await unconfirmed(WAREHOUSE, ADJUST_FIELDS, ADJUST);
    answer = () => json(201, STOCK_CHANGE);
    await expect(
      run(
        WAREHOUSE,
        retryForm(adjust.state, {
          [STOCK_ITEM_FIELD]: ITEM_ID,
          [DIRECTION_FIELD]: 'DECREASE',
          [AMOUNT_FIELD]: '5',
        }),
        adjust.state,
      ),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(sent[1]!.body).toEqual(sent[0]!.body);
    expect(sent[1]!.key).toBe(sent[0]!.key);

    sent = [];
    const created = await unconfirmed(WAREHOUSE, SHIPMENT_FIELDS, NEW_SHIPMENT);
    answer = () => json(201, { id: SHIPMENT_ID, status: 'CREATED' });
    const kept = created.state.body as unknown as { legs: { carrierName: string }[] };
    expect(kept.legs).toHaveLength(2);
    await expect(
      run(
        WAREHOUSE,
        retryForm(created.state, {
          [CONSIGNEE_FIELD]: CONSIGNEE,
          [ORDER_FIELD]: `ORD_${ULID}`,
          [legField(0, 'carrierName')]: 'باربری یک',
          [legField(0, 'carrierReference')]: 'WB-1',
          [legField(1, 'carrierName')]: 'باربری دو',
        }),
        created.state,
      ),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(sent[1]!.body).toEqual(sent[0]!.body);
    expect(sent[1]!.key).toBe(sent[0]!.key);
  });

  it('a retry of a dispatch carries the stamped version, with no body in the form', async () => {
    const { state } = await unconfirmed(SHIPMENT, {}, DISPATCH);
    expect(state.body).toBeNull();
    answer = () => json(200, { id: SHIPMENT_ID, status: 'DISPATCHED' });
    await expect(run(SHIPMENT, retryForm(state), state)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ key: sent[0]!.key, body: { expectedVersion: 1 } });
  });

  it('a refused retry proves nothing: the original request stays, with a note', async () => {
    const { state } = await unconfirmed(SHIPMENT, {}, DISPATCH);
    answer = () => problem(409, 'INVALID_STATE_TRANSITION', { detail: 'SHIPMENT_NOT_CREATED' });
    expect(await run(SHIPMENT, retryForm(state), state)).toEqual({ ...state, retryRefused: true });
  });

  it('a retry that is unconfirmed again says so', async () => {
    const { state } = await unconfirmed(SHIPMENT, {}, DISPATCH);
    expect(await run(SHIPMENT, retryForm(state), state)).toMatchObject({
      kind: 'UNCONFIRMED',
      submissionId: state.submissionId,
      retryUnknown: true,
    });
  });

  it('a retry with the session ended, or only unavailable', async () => {
    const { state } = await unconfirmed(SHIPMENT, {}, DISPATCH);
    currentSession.mockResolvedValue(null);
    expect(await run(SHIPMENT, retryForm(state), state)).toEqual({ ...state, sessionEnded: true });
    missingSessionReason.mockResolvedValue('SESSION_UNAVAILABLE');
    expect(await run(SHIPMENT, retryForm(state), state)).toEqual({ ...state, retryUnknown: true });
  });

  it('a retry past the deadline is not sent, and the view becomes read-only for good', async () => {
    const { state } = await unconfirmed(SHIPMENT, {}, DISPATCH);
    const late = retryForm(state);
    jest.useFakeTimers({ now: Date.now() + 2 * 60 * 60 * 1000 });
    try {
      expect(await run(SHIPMENT, late, state)).toEqual({
        ...state,
        replay: null,
        viewOnly: true,
        replayExpired: true,
      });
    } finally {
      jest.useRealTimers();
    }
    expect(sent).toHaveLength(1);
  });
});
