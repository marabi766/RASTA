/**
 * @jest-environment node
 */
import { mintReturnStamp, returnReplayWindowSeconds, verifyReturnStamp } from './return-replay';
import { mintSubmissionId } from './submission';
import type { WebSession } from './session';
import { actingAccessToken } from '@/test/session-token';

/**
 * The return replay stamp: what it binds a submission to, and until when the
 * same request may be sent — `dispute-replay.spec.ts`'s cases, for the return
 * commands.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SESSION = {
  subject: 'user-1',
  username: 'supplier',
  organizationId: 'ORG-DEH-0002',
  accessToken: actingAccessToken('ORG-DEH-0002'),
  accessTokenExpiresAt: 1_900_000_600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const ENV = { WEB_MARKETPLACE_IDEMPOTENCY_TTL_HOURS: 1, WEB_RETURN_REPLAY_MARGIN_SECONDS: 600 };
const NOW = 1_900_000_000_000;
const SUB = mintSubmissionId(SESSION);
const RETURN = { kind: 'RETURN', returnId: 'RET_1' } as const;
const ORDER = { kind: 'ORDER', orderId: 'ORD_1' } as const;

it('the window is the retention less the margin', () => {
  expect(returnReplayWindowSeconds(ENV)).toBe(3000);
});

it('binds a decision to its request and its command', () => {
  const { token, until } = mintReturnStamp(
    SESSION,
    { command: 'REJECT', returnId: 'RET_1' },
    SUB,
    NOW,
    ENV,
  );
  expect(until).toBe(NOW + 3000 * 1000);
  expect(verifyReturnStamp(SESSION, token, RETURN, SUB, NOW + 1000, ENV)).toEqual({
    token,
    until,
    command: 'REJECT',
  });
});

it('a request’s stamp names the order, and never passes on a request’s form — nor the reverse', () => {
  const request = mintReturnStamp(SESSION, { command: 'REQUEST', orderId: 'ORD_1' }, SUB, NOW, ENV);
  expect(verifyReturnStamp(SESSION, request.token, ORDER, SUB, NOW, ENV)?.command).toBe('REQUEST');
  expect(
    verifyReturnStamp(SESSION, request.token, { kind: 'RETURN', returnId: 'ORD_1' }, SUB, NOW, ENV),
  ).toBeNull();
  const cancel = mintReturnStamp(SESSION, { command: 'CANCEL', returnId: 'RET_1' }, SUB, NOW, ENV);
  expect(
    verifyReturnStamp(SESSION, cancel.token, { kind: 'ORDER', orderId: 'RET_1' }, SUB, NOW, ENV),
  ).toBeNull();
});

it.each([
  ['another request', { kind: 'RETURN', returnId: 'RET_2' } as const, SUB],
  ['another submission id', RETURN, mintSubmissionId(SESSION)],
])('refuses %s', (_name, scope, submission) => {
  const { token } = mintReturnStamp(
    SESSION,
    { command: 'AUTHORIZE', returnId: 'RET_1' },
    SUB,
    NOW,
    ENV,
  );
  expect(verifyReturnStamp(SESSION, token, scope, submission, NOW, ENV)).toBeNull();
});

it('refuses another login’s stamp', () => {
  const { token } = mintReturnStamp(
    SESSION,
    { command: 'AUTHORIZE', returnId: 'RET_1' },
    SUB,
    NOW,
    ENV,
  );
  expect(
    verifyReturnStamp({ ...SESSION, subject: 'someone-else' }, token, RETURN, SUB, NOW, ENV),
  ).toBeNull();
});

it('refuses past its deadline, and past a retention shortened since', () => {
  const target = { command: 'AUTHORIZE', returnId: 'RET_1' } as const;
  const { token } = mintReturnStamp(SESSION, target, SUB, NOW, ENV);
  expect(verifyReturnStamp(SESSION, token, RETURN, SUB, NOW + 3001 * 1000, ENV)).toBeNull();

  const long = { ...ENV, WEB_MARKETPLACE_IDEMPOTENCY_TTL_HOURS: 24 };
  const issued = mintReturnStamp(SESSION, target, SUB, NOW, long).token;
  const later = NOW + 2 * 60 * 60 * 1000;
  expect(verifyReturnStamp(SESSION, issued, RETURN, SUB, later, long)).not.toBeNull();
  expect(verifyReturnStamp(SESSION, issued, RETURN, SUB, later, ENV)).toBeNull();
});

it('refuses anything that is not a stamp', () => {
  for (const token of [null, '', 'x.y', 42]) {
    expect(verifyReturnStamp(SESSION, token, RETURN, SUB, NOW, ENV)).toBeNull();
  }
});
