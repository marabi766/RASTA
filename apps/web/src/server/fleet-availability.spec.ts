/**
 * @jest-environment node
 */
import { EMPTY_DECLARE_AVAILABILITY_FORM, type WindowState } from '@/lib/fleet-availability-fields';

import { RECORD_KEY_REUSED_MESSAGE } from './asset-records';
import {
  ALREADY_REVOKED_MESSAGE,
  END_NOT_AFTER_START_MESSAGE,
  canManageAvailability,
  declareAvailability,
  declareAvailabilityFormValues,
  fetchAvailability,
  fetchAvailabilityWindows,
  isRevocable,
  openAvailabilityBaseline,
  parseDeclareAvailabilityForm,
  revokeAvailability,
  sealAvailabilityBaseline,
  windowStateOf,
  type AvailabilityWindow,
} from './fleet-availability';
import type { WebSession } from './session';

/**
 * The two availability commands and their reads: who is offered the forms, what
 * a person may type and in what words a mistake is reported, the signed
 * baselines a form carries, a declaration's state on the server's clock, what is
 * sent to which path under which key, and every sentence the service says in
 * Persian.
 *
 * The form's rules are a courtesy that saves a round trip; the service is the
 * enforcement (`fleet-availability.contract.spec.ts` pins the two together).
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

beforeEach(() => {
  Object.assign(process.env, {
    API_GATEWAY_URL: 'http://gateway.test:3000',
    OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
    OIDC_CLIENT_ID: 'rasta-web',
    WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
    WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  });
});

const ASSET = 'AST_01J00000000000000000000000';
const WINDOW = 'AVW_01J00000000000000000000000';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const FORM = {
  ...EMPTY_DECLARE_AVAILABILITY_FORM,
  available: 'false',
  reason: 'رزرو برای پروژهٔ راه‌سازی',
};

describe('who is offered the forms', () => {
  it.each([
    [['ORGANIZATION_ADMIN'], true],
    [['FLEET_MANAGER'], true],
    [['UNION_ADMIN'], true],
    [['OPERATOR'], false],
    [['DRIVER', 'OPERATOR'], false],
    [[], false],
  ])('%j: %s', (roles, expected) => {
    expect(canManageAvailability(roles)).toBe(expected);
  });
});

describe('the declare form', () => {
  it('reads every field, and a missing one as blank', () => {
    const form = new FormData();
    form.set('reason', 'X');
    expect(declareAvailabilityFormValues(form)).toEqual({
      ...EMPTY_DECLARE_AVAILABILITY_FORM,
      reason: 'X',
    });
  });

  it('turns what was typed into the body the service takes: a boolean, and Tehran-midnight days', () => {
    expect(
      parseDeclareAvailabilityForm({
        available: 'false',
        reason: '  رزرو   برای پروژه ',
        fromAt: '2026-10-10',
        toAt: '2026-10-20',
      }),
    ).toEqual({
      ok: true,
      body: {
        available: false,
        reason: 'رزرو برای پروژه',
        fromAt: '2026-10-09T20:30:00.000Z',
        toAt: '2026-10-19T20:30:00.000Z',
      },
    });
    const free = parseDeclareAvailabilityForm({ ...FORM, available: 'true' });
    expect(free.ok && free.body.available).toBe(true);
  });

  it('leaves a blank day out: from means now, to means until revoked — decided by the service, not guessed here', () => {
    expect(parseDeclareAvailabilityForm(FORM)).toEqual({
      ok: true,
      body: { available: false, reason: 'رزرو برای پروژهٔ راه‌سازی' },
    });
  });

  it('refuses an end that is not after the start, only when both were typed', () => {
    const refused = parseDeclareAvailabilityForm({
      ...FORM,
      fromAt: '2026-10-10',
      toAt: '2026-10-10',
    });
    expect(refused).toEqual({ ok: false, fieldErrors: { toAt: END_NOT_AFTER_START_MESSAGE } });
    // Alone, an end is the service's to read against "now".
    expect(parseDeclareAvailabilityForm({ ...FORM, toAt: '2020-01-01' }).ok).toBe(true);
  });

  it.each([
    ['no choice', { available: '' }, 'available'],
    ['a choice the form does not offer', { available: 'maybe' }, 'available'],
    ['no reason', { reason: '  ' }, 'reason'],
    ['a two-letter reason', { reason: 'رز' }, 'reason'],
    ['a reason over 500 characters', { reason: 'ر'.repeat(501) }, 'reason'],
    [
      'a reason with a right-to-left override',
      { reason: `رزرو${String.fromCodePoint(0x202e)}x` },
      'reason',
    ],
    [
      'an Arabic letter mark in the reason',
      { reason: `رزرو${String.fromCodePoint(0x061c)}ی` },
      'reason',
    ],
    ['a reason with markup', { reason: '<img src=x onerror=alert(1)>' }, 'reason'],
    ['an impossible start', { fromAt: '2026-13-01' }, 'fromAt'],
    ['text for an end', { toAt: 'فردا' }, 'toAt'],
  ] as const)('refuses %s, on the field that holds it', (_name, over, field) => {
    const parsed = parseDeclareAvailabilityForm({ ...FORM, ...over });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(Object.keys(parsed.fieldErrors)).toEqual([field]);
  });
});

describe('the baselines a form carries', () => {
  it('opens a declare baseline for the declare command only, and without a window', () => {
    const token = sealAvailabilityBaseline(SESSION, { assetId: ASSET, command: 'declare' });
    expect(openAvailabilityBaseline(SESSION, token, 'declare')).toEqual(
      expect.objectContaining({ assetId: ASSET, command: 'declare' }),
    );
    expect(openAvailabilityBaseline(SESSION, token, 'revoke')).toBeNull();
  });

  it('opens a revoke baseline only for revoke, and only when it names its window', () => {
    const token = sealAvailabilityBaseline(SESSION, {
      assetId: ASSET,
      command: 'revoke',
      windowId: WINDOW,
    });
    expect(openAvailabilityBaseline(SESSION, token, 'revoke')).toEqual(
      expect.objectContaining({ windowId: WINDOW }),
    );
    expect(openAvailabilityBaseline(SESSION, token, 'declare')).toBeNull();
    // A revoke that names no window, and a declare that names one, were never issued.
    const windowless = sealAvailabilityBaseline(SESSION, { assetId: ASSET, command: 'revoke' });
    expect(openAvailabilityBaseline(SESSION, windowless, 'revoke')).toBeNull();
    const stray = sealAvailabilityBaseline(SESSION, {
      assetId: ASSET,
      command: 'declare',
      windowId: WINDOW,
    });
    expect(openAvailabilityBaseline(SESSION, stray, 'declare')).toBeNull();
  });

  it('refuses forged, somebody else’s, earlier-login and missing tokens with one answer', () => {
    const token = sealAvailabilityBaseline(SESSION, { assetId: ASSET, command: 'declare' });
    for (const bad of [
      null,
      'chosen-by-the-client',
      `${token.slice(0, -2)}AA`,
      sealAvailabilityBaseline(
        { ...SESSION, subject: 'someone-else' },
        { assetId: ASSET, command: 'declare' },
      ),
      sealAvailabilityBaseline(
        { ...SESSION, csrfToken: 'earlier-login' },
        { assetId: ASSET, command: 'declare' },
      ),
    ]) {
      expect(openAvailabilityBaseline(SESSION, bad, 'declare')).toBeNull();
    }
  });
});

describe('a declaration’s state, on the server’s clock', () => {
  const window = (over: Partial<AvailabilityWindow> = {}): AvailabilityWindow => ({
    id: WINDOW,
    assetId: ASSET,
    available: false,
    fromAt: '2026-10-01T00:00:00.000Z',
    toAt: '2026-10-31T00:00:00.000Z',
    reason: 'رزرو',
    createdAt: '2026-09-30T00:00:00.000Z',
    revokedAt: null,
    ...over,
  });

  it.each([
    ['before it begins', '2026-09-30T23:59:59.999Z', {}, 'SCHEDULED'],
    ['at the very start', '2026-10-01T00:00:00.000Z', {}, 'IN_FORCE'],
    ['in the middle', '2026-10-15T00:00:00.000Z', {}, 'IN_FORCE'],
    [
      'at the end instant, as the service reads it (to >= now)',
      '2026-10-31T00:00:00.000Z',
      {},
      'IN_FORCE',
    ],
    ['after the end', '2026-10-31T00:00:00.001Z', {}, 'ENDED'],
    ['with no end: until revoked', '2030-01-01T00:00:00.000Z', { toAt: null }, 'IN_FORCE'],
    [
      'revoked, whatever its dates say',
      '2026-10-15T00:00:00.000Z',
      { revokedAt: '2026-10-05T00:00:00.000Z' },
      'REVOKED',
    ],
  ] as const)('%s', (_when, now, over, expected) => {
    expect(windowStateOf(window(over), new Date(now))).toBe(expected);
  });

  it('never calls a declaration whose dates cannot be read in force', () => {
    expect(windowStateOf(window({ fromAt: 'soon' }), new Date('2026-10-15T00:00:00Z'))).toBe(
      'ENDED',
    );
    expect(windowStateOf(window({ toAt: 'later' }), new Date('2026-10-15T00:00:00Z'))).toBe(
      'ENDED',
    );
    expect(windowStateOf(window(), new Date(Number.NaN))).toBe('ENDED');
  });

  it.each([
    ['IN_FORCE', true],
    ['SCHEDULED', true],
    ['ENDED', false],
    ['REVOKED', false],
  ] as Array<[WindowState, boolean]>)('%s is revocable: %s', (state, expected) => {
    expect(isRevocable(state)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function gateway(answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = answers.shift();
    if (!next) throw new Error('unexpected gateway call');
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

describe('declaring', () => {
  const body = { available: false, reason: 'رزرو برای پروژه' };

  it('posts the page’s asset and the body, with the submission as the replay key', async () => {
    const g = gateway([json(201, { id: WINDOW, assetId: ASSET })]);

    const result = await declareAvailability(SESSION, ASSET, body, SUBMISSION, g.fetchImpl);

    expect(result.kind).toBe('CREATED');
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]!.method).toBe('POST');
    expect(new URL(g.calls[0]!.url).pathname).toBe('/v1/fleet/availability');
    expect(g.calls[0]!.body).toEqual({ assetId: ASSET, ...body });
    expect(g.calls[0]!.headers['idempotency-key']).toBe(SUBMISSION);
    expect(g.calls[0]!.headers.authorization).toBe('Bearer access-token-value');
  });

  it('places the service’s field errors on the form’s fields', async () => {
    const g = gateway([
      json(400, {
        code: 'VALIDATION_FAILED',
        message: 'Validation failed',
        details: [{ path: 'toAt', message: 'toAt must be after fromAt' }],
      }),
    ]);
    const result = await declareAvailability(SESSION, ASSET, body, SUBMISSION, g.fetchImpl);
    expect(result).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { toAt: END_NOT_AFTER_START_MESSAGE },
    });
  });

  it('words a reused key', async () => {
    const g = gateway([
      json(409, {
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key was already used with a different request body',
      }),
    ]);
    expect(await declareAvailability(SESSION, ASSET, body, SUBMISSION, g.fetchImpl)).toMatchObject({
      kind: 'INVALID',
      message: RECORD_KEY_REUSED_MESSAGE,
    });
  });

  it('answers another organization’s machine as a missing one, and a lost answer as unconfirmed', async () => {
    const missing = gateway([json(404, { code: 'NOT_FOUND', message: 'Asset not found' })]);
    expect(
      (await declareAvailability(SESSION, ASSET, body, SUBMISSION, missing.fetchImpl)).kind,
    ).toBe('NOT_FOUND');
    const lost = gateway([new TypeError('terminated')]);
    expect((await declareAvailability(SESSION, ASSET, body, SUBMISSION, lost.fetchImpl)).kind).toBe(
      'UNKNOWN_OUTCOME',
    );
  });

  it('answers a conflict that says wait as "in progress", never as a refusal', async () => {
    const g = gateway([json(409, { code: 'CONFLICT', message: 'busy' }, { 'retry-after': '1' })]);
    expect((await declareAvailability(SESSION, ASSET, body, SUBMISSION, g.fetchImpl)).kind).toBe(
      'IN_PROGRESS',
    );
  });
});

describe('revoking', () => {
  it('posts to the window’s own path, with no body, and the submission as the key', async () => {
    const g = gateway([json(200, { id: WINDOW, assetId: ASSET })]);

    const result = await revokeAvailability(SESSION, WINDOW, SUBMISSION, g.fetchImpl);

    expect(result.kind).toBe('CREATED');
    expect(new URL(g.calls[0]!.url).pathname).toBe(`/v1/fleet/availability/${WINDOW}/revoke`);
    expect(g.calls[0]!.method).toBe('POST');
    expect(g.calls[0]!.body).toBeUndefined();
  });

  it('encodes the window id into the path rather than interpolating it', async () => {
    const g = gateway([json(200, { id: WINDOW })]);
    await revokeAvailability(SESSION, 'a/../b', SUBMISSION, g.fetchImpl);
    expect(new URL(g.calls[0]!.url).pathname).toBe('/v1/fleet/availability/a%2F..%2Fb/revoke');
  });

  it('says a declaration that is already withdrawn is already withdrawn — a replay is a refusal, not a second change', async () => {
    const g = gateway([
      json(409, {
        code: 'INVALID_STATE_TRANSITION',
        message: 'This availability window has already been revoked',
      }),
    ]);
    expect(await revokeAvailability(SESSION, WINDOW, SUBMISSION, g.fetchImpl)).toMatchObject({
      kind: 'INVALID',
      message: ALREADY_REVOKED_MESSAGE,
    });
  });

  it('answers another organization’s window as a missing one', async () => {
    const g = gateway([json(404, { code: 'NOT_FOUND', message: 'AvailabilityWindow not found' })]);
    expect((await revokeAvailability(SESSION, WINDOW, SUBMISSION, g.fetchImpl)).kind).toBe(
      'NOT_FOUND',
    );
  });
});

describe('the reads', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const stub = (answer: Response) => {
    const calls: string[] = [];
    global.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return answer;
    }) as typeof fetch;
    return calls;
  };

  it('reads the machine’s composed answer by asset id, encoded, and keeps only that machine’s row', async () => {
    const calls = stub(
      json(200, {
        items: [
          { assetId: 'AST_OTHER', available: true, blockers: [] },
          {
            assetId: ASSET,
            available: false,
            blockers: [
              {
                code: 'DISPATCH_BLOCKED',
                owner: 'asset-service',
                detail: 'x',
                cause: 'INSURANCE',
                coverages: ['THIRD_PARTY'],
              },
            ],
          },
        ],
        at: '2026-10-05T00:00:00.000Z',
      }),
    );
    const result = await fetchAvailability(SESSION, ASSET);

    expect(new URL(calls[0]!).pathname + new URL(calls[0]!).search).toBe(
      `/v1/fleet/availability?assetId=${ASSET}&limit=1`,
    );
    expect(result.kind === 'OK' && result.data?.assetId).toBe(ASSET);
  });

  it('is null — not an error — when fleet-service has no row for the machine yet', async () => {
    stub(json(200, { items: [], at: '2026-10-05T00:00:00.000Z' }));
    expect(await fetchAvailability(SESSION, ASSET)).toEqual({ kind: 'OK', data: null });
  });

  it('reads the declarations, and says a shape it cannot read is malformed', async () => {
    stub(
      json(200, {
        items: [
          {
            id: WINDOW,
            assetId: ASSET,
            available: false,
            fromAt: 'a',
            reason: 'r',
            createdAt: 'c',
          },
        ],
        hasMore: false,
      }),
    );
    const ok = await fetchAvailabilityWindows(SESSION, ASSET);
    expect(ok.kind).toBe('OK');
    stub(json(200, { rows: [] }));
    expect((await fetchAvailabilityWindows(SESSION, ASSET)).kind).toBe('MALFORMED');
  });

  it('answers another organization’s machine as not found', async () => {
    stub(json(404, { code: 'NOT_FOUND', message: 'Asset not found' }));
    expect((await fetchAvailabilityWindows(SESSION, ASSET)).kind).toBe('NOT_FOUND');
  });
});
