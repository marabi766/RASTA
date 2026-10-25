/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

/**
 * PR 319 review 3, finding 2, end to end in memory: the real middleware, the
 * real session refresh and coordinator, then the real `/auth/session` route,
 * the real dispute action and the real place-order action, each reading
 * exactly the cookie and headers middleware forwarded.
 *
 * The access token has one second left when the refresh starts; the provider
 * takes two and fails for a reason that may pass. The login is recoverable,
 * so neither the route nor the action may say it has ended — before the fix,
 * `usable` was judged from the instant before the refresh, no mark was set,
 * and both said "ended" once their own clock found the token expired.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  WEB_COOKIE_SECURE: 'false',
});
delete process.env.WEB_REDIS_URL;

let clock = 1_900_000_000_000;
const refreshTokens = jest.fn();
const issueDisputeCommand = jest.fn();
const placeOrder = jest.fn();

/** What middleware handed the route: its forwarded request headers and cookie. */
let forwarded = new Headers();

jest.mock('@/server/oidc', () => {
  const actual = jest.requireActual('@/server/oidc');
  return { ...actual, refreshTokens: (...args: unknown[]) => refreshTokens(...args) };
});
jest.mock('@/server/transactions', () => {
  const actual = jest.requireActual('@/server/transactions');
  return { ...actual, issueDisputeCommand: (...args: unknown[]) => issueDisputeCommand(...args) };
});
jest.mock('@/server/place-order', () => {
  const actual = jest.requireActual('@/server/place-order');
  return { ...actual, placeOrder: (...args: unknown[]) => placeOrder(...args) };
});
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
jest.mock('next/headers', () => ({
  headers: async () => forwarded,
  cookies: async () => ({
    get: (name: string) => {
      const pair = (forwarded.get('cookie') ?? '')
        .split(/;\s*/)
        .map((item) => item.split('='))
        .find(([key]) => key === name);
      return pair ? { name, value: pair.slice(1).join('=') } : undefined;
    },
  }),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { middleware } = require('./middleware') as typeof import('./middleware');
const { GET } = require('./app/auth/session/route') as typeof import('./app/auth/session/route');
const { submitDisputeCommand } =
  require('./app/transactions/[id]/actions') as typeof import('./app/transactions/[id]/actions');
const { submitPlaceOrder } =
  require('./app/marketplace/[productId]/place-order-actions') as typeof import('./app/marketplace/[productId]/place-order-actions');
const { IDLE_PLACE_ORDER_FORM } =
  require('./app/marketplace/[productId]/place-order-form-state') as typeof import('./app/marketplace/[productId]/place-order-form-state');
const { OidcError } = require('@/server/oidc') as typeof import('@/server/oidc');
const { SESSION_COOKIE, sealSession } =
  require('@/server/session') as typeof import('@/server/session');
const { forgetSharedRefreshes } =
  require('@/server/session-refresh') as typeof import('@/server/session-refresh');
const { mintSubmissionId, SUBMISSION_FIELD } =
  require('@/server/submission') as typeof import('@/server/submission');
const { mintReplayStamp } =
  require('@/server/dispute-replay') as typeof import('@/server/dispute-replay');
const { CSRF_FIELD } = require('@/server/csrf') as typeof import('@/server/csrf');
const { REPLAY_FIELD } = require('@/lib/form-fields') as typeof import('@/lib/form-fields');
const { EMPTY_DISPUTE_FORM } =
  require('@/lib/transaction-dispute-fields') as typeof import('@/lib/transaction-dispute-fields');
const { IDLE_DISPUTE_FORM } =
  require('./app/transactions/[id]/form-state') as typeof import('./app/transactions/[id]/form-state');
/* eslint-enable @typescript-eslint/no-require-imports */

const TXN = 'TXN_1';
const REASON = 'کالا تحویل نشده و پاسخی هم نیامده است';

function session(accessTokenExpiresAt: number) {
  return {
    subject: 'user-1',
    username: 'payer',
    organizationId: 'ORG-DEH-0001',
    accessToken: 'access-token-value',
    accessTokenExpiresAt,
    refreshToken: 'refresh-token-value',
    csrfToken: 'csrf-token-for-this-session',
    issuedAt: Math.floor(clock / 1000) - 60,
  };
}

/** Runs middleware for an action POST, and keeps what it forwards to the route. */
async function throughMiddleware(cookie: string, path = `/transactions/${TXN}`): Promise<void> {
  const response = await middleware(
    new NextRequest(`http://localhost:3200${path}`, {
      method: 'GET',
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    }),
  );
  forwarded = new Headers();
  const names = (response.headers.get('x-middleware-override-headers') ?? '').split(',');
  for (const name of names.filter(Boolean)) {
    const value = response.headers.get(`x-middleware-request-${name}`);
    if (value !== null) forwarded.set(name, value);
  }
}

function dispute(sessionValue: ReturnType<typeof session>) {
  const submission = mintSubmissionId(sessionValue);
  const replay = mintReplayStamp(sessionValue, TXN, submission);
  const form = new FormData();
  form.set('command', 'DISPUTE');
  form.set('reason', REASON);
  form.set(CSRF_FIELD, sessionValue.csrfToken);
  form.set(SUBMISSION_FIELD, submission);
  form.set(REPLAY_FIELD, replay.token);
  return {
    form,
    previous: {
      kind: 'UNCONFIRMED' as const,
      command: 'DISPUTE' as const,
      correlationId: 'corr-original',
      submissionId: submission,
      values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
      replay,
    },
  };
}

/** An order form as the page drew it, and the same order once its outcome is unknown. */
function order(sessionValue: ReturnType<typeof session>) {
  const submission = mintSubmissionId(sessionValue);
  const form = new FormData();
  form.set('offerId', 'OFR_1');
  form.set('quantity', '3');
  form.set(CSRF_FIELD, sessionValue.csrfToken);
  form.set(SUBMISSION_FIELD, submission);
  return {
    form,
    previous: {
      kind: 'UNCONFIRMED' as const,
      correlationId: 'corr-original',
      submissionId: submission,
      values: { offerId: 'OFR_1', quantity: '3' },
    },
  };
}

beforeEach(() => {
  clock = 1_900_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  forgetSharedRefreshes();
  refreshTokens.mockReset();
  issueDisputeCommand.mockReset();
  placeOrder.mockReset();
  forwarded = new Headers();
});

afterEach(() => jest.restoreAllMocks());

describe('the token expires during a refresh that fails transiently', () => {
  beforeEach(() => {
    refreshTokens.mockImplementation(async () => {
      clock += 2_000;
      throw new OidcError('TOKEN_REQUEST_FAILED', 'the identity provider answered 503');
    });
  });

  const live = () => session(Math.floor(clock / 1000) + 1);
  const cookie = (value: ReturnType<typeof session>) =>
    sealSession(value, process.env.WEB_SESSION_SECRET!);

  it('/auth/session answers 503 — unknown — not 401', async () => {
    await throughMiddleware(cookie(live()), '/auth/session');
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect((await GET()).status).toBe(503);
  });

  it('a retry stays unknown with its retry; nothing is sent', async () => {
    const value = live();
    const { form, previous } = dispute(value);
    await throughMiddleware(cookie(value));
    const state = await submitDisputeCommand(TXN, previous, form);
    expect(state).toEqual({ ...previous, retryUnknown: true });
    expect(state).not.toHaveProperty('sessionEnded');
    expect(issueDisputeCommand).not.toHaveBeenCalled();
  });

  it('a first send is refused as unavailable, not "ended"; nothing is sent', async () => {
    const value = live();
    const { form } = dispute(value);
    await throughMiddleware(cookie(value));
    expect(await submitDisputeCommand(TXN, IDLE_DISPUTE_FORM, form)).toEqual({
      kind: 'REFUSED',
      reason: 'SESSION_UNAVAILABLE',
    });
    expect(issueDisputeCommand).not.toHaveBeenCalled();
  });
});

describe('the same expiry during a failing refresh, on an order', () => {
  beforeEach(() => {
    refreshTokens.mockImplementation(async () => {
      clock += 2_000;
      throw new OidcError('TOKEN_REQUEST_FAILED', 'the identity provider answered 503');
    });
  });

  const live = () => session(Math.floor(clock / 1000) + 1);
  const cookie = (value: ReturnType<typeof session>) =>
    sealSession(value, process.env.WEB_SESSION_SECRET!);

  it('a first send is refused as unavailable, not "ended"; nothing is ordered', async () => {
    const value = live();
    const { form } = order(value);
    await throughMiddleware(cookie(value), '/marketplace/PRD_1');
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, form)).toEqual({
      kind: 'REFUSED',
      reason: 'SESSION_UNAVAILABLE',
    });
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('a retry of an unknown order stays unknown with its retry: same key, same body', async () => {
    const value = live();
    const { form, previous } = order(value);
    await throughMiddleware(cookie(value), '/marketplace/PRD_1');
    const state = await submitPlaceOrder(previous, form);
    expect(state).toEqual({ ...previous, retryUnknown: true });
    expect(state).not.toHaveProperty('sessionEnded');
    expect(placeOrder).not.toHaveBeenCalled();
  });
});

describe('a session that has ended, through the same path', () => {
  it('a cookie that does not open: 401, and a retry says the session ended', async () => {
    const value = session(Math.floor(clock / 1000) + 600);
    const { form, previous } = dispute(value);

    await throughMiddleware('not-a-sealed-session', '/auth/session');
    expect((await GET()).status).toBe(401);

    await throughMiddleware('not-a-sealed-session');
    expect(await submitDisputeCommand(TXN, previous, form)).toEqual({
      ...previous,
      sessionEnded: true,
    });
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(issueDisputeCommand).not.toHaveBeenCalled();
  });

  it('a cookie that does not open: a retry of an unknown order says the session ended', async () => {
    const { form, previous } = order(session(Math.floor(clock / 1000) + 600));
    await throughMiddleware('not-a-sealed-session', '/marketplace/PRD_1');
    expect(await submitPlaceOrder(previous, form)).toEqual({ ...previous, sessionEnded: true });
    expect(placeOrder).not.toHaveBeenCalled();
  });
});
