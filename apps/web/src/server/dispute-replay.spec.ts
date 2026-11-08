/**
 * @jest-environment node
 */

import { actingAccessToken } from '@/test/session-token';

/**
 * The dispute replay deadline (`dispute-replay.ts`): signed with its issuance,
 * and bound by the window as configured **now** as well as by its own expiry
 * (PR 319 review 3, finding 1 — a configuration rollover).
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

/* eslint-disable @typescript-eslint/no-require-imports */
const { mintReplayStamp, replayWindowSeconds, verifyReplayStamp } =
  require('./dispute-replay') as typeof import('./dispute-replay');
const { mintSubmissionId } = require('./submission') as typeof import('./submission');
/* eslint-enable @typescript-eslint/no-require-imports */

const SESSION = {
  subject: 'user-1',
  username: 'operator',
  organizationId: 'ORG-UNION-0001',
  accessToken: actingAccessToken('ORG-UNION-0001'),
  accessTokenExpiresAt: 1_900_000_600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
};

const HOUR = 60 * 60 * 1000;
const T0 = 1_900_000_000_000;
const TXN = 'TXN_1';
const LONG = { WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS: 24, WEB_DISPUTE_REPLAY_MARGIN_SECONDS: 600 };
const SHORT = { WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS: 1, WEB_DISPUTE_REPLAY_MARGIN_SECONDS: 600 };

const submission = mintSubmissionId(SESSION);

describe('a stamp issued under a longer retention, after the retention is shortened', () => {
  // Both TTLs 24 h when the form is drawn at T0; both cut to 1 h, same secret.
  // The first send at +2 h made economic's record live until +3 h; a retry at
  // +4 h would reach it gone, and run against a newer dispute.
  const stamp = mintReplayStamp(SESSION, TXN, submission, T0, LONG);

  it('is still valid under the configuration it was issued with', () => {
    expect(verifyReplayStamp(SESSION, stamp.token, TXN, submission, T0 + 4 * HOUR, LONG)).toEqual({
      ...stamp,
      disputeId: null,
    });
  });

  it('is refused at +4 h once the window as configured now has passed', () => {
    expect(
      verifyReplayStamp(SESSION, stamp.token, TXN, submission, T0 + 4 * HOUR, SHORT),
    ).toBeNull();
  });

  it('is accepted inside the current window from its issuance, with the earlier deadline', () => {
    const at = T0 + 40 * 60 * 1000;
    expect(verifyReplayStamp(SESSION, stamp.token, TXN, submission, at, SHORT)).toEqual({
      token: stamp.token,
      until: T0 + replayWindowSeconds(SHORT) * 1000,
      disputeId: null,
    });
  });

  it('is refused one millisecond past issuance plus the current window', () => {
    const edge = T0 + replayWindowSeconds(SHORT) * 1000;
    expect(verifyReplayStamp(SESSION, stamp.token, TXN, submission, edge, SHORT)).not.toBeNull();
    expect(verifyReplayStamp(SESSION, stamp.token, TXN, submission, edge + 1, SHORT)).toBeNull();
  });
});

describe('a longer retention never extends a stamp', () => {
  it('its own signed expiry still binds', () => {
    const stamp = mintReplayStamp(SESSION, TXN, submission, T0, SHORT);
    expect(
      verifyReplayStamp(SESSION, stamp.token, TXN, submission, T0 + 2 * HOUR, LONG),
    ).toBeNull();
    expect(
      verifyReplayStamp(SESSION, stamp.token, TXN, submission, T0 + 40 * 60 * 1000, LONG)?.until,
    ).toBe(stamp.until);
  });
});

describe('what it is bound to', () => {
  const stamp = mintReplayStamp(SESSION, TXN, submission, T0, SHORT);
  const at = T0 + 60_000;

  it.each([
    ['another transaction', SESSION, 'TXN_OTHER', submission],
    ['another submission id', SESSION, TXN, mintSubmissionId(SESSION)],
    ['another login', { ...SESSION, csrfToken: 'another-login' }, TXN, submission],
  ])('refuses %s', (_label, who, transaction, key) => {
    expect(verifyReplayStamp(who, stamp.token, transaction, key, at, SHORT)).toBeNull();
  });

  it('refuses a token whose issuance was changed', () => {
    const [body, mac] = stamp.token.split('.');
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
    const forged = Buffer.from(JSON.stringify({ ...payload, issuedAt: T0 + 10 * HOUR })).toString(
      'base64url',
    );
    expect(
      verifyReplayStamp(SESSION, `${forged}.${mac}`, TXN, submission, T0 + 2 * HOUR, SHORT),
    ).toBeNull();
  });
});

/**
 * PR 325 review 1, finding 1: a resolution's stamp signs the dispute the page
 * showed, and verifying it returns that identity — never one the request could
 * choose.
 */
describe('the dispute a resolution decides', () => {
  const submission = mintSubmissionId(SESSION);
  const target = { transactionId: TXN, disputeId: 'TXD_A' };

  it('is signed into the stamp and returned on verification', () => {
    const stamp = mintReplayStamp(SESSION, target, submission, T0, SHORT);
    expect(verifyReplayStamp(SESSION, stamp.token, TXN, submission, T0 + HOUR / 2, SHORT)).toEqual({
      ...stamp,
      disputeId: 'TXD_A',
    });
  });

  it('is null for a stamp that decides no dispute (opening one)', () => {
    const stamp = mintReplayStamp(SESSION, TXN, submission, T0, SHORT);
    expect(
      verifyReplayStamp(SESSION, stamp.token, TXN, submission, T0 + HOUR / 2, SHORT)?.disputeId,
    ).toBeNull();
  });

  it('cannot be swapped for another: a stamp whose dispute was edited does not verify', () => {
    const stamp = mintReplayStamp(SESSION, target, submission, T0, SHORT);
    const [payload, mac] = stamp.token.split('.') as [string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const swapped = Buffer.from(JSON.stringify({ ...claims, disputeId: 'TXD_B' })).toString(
      'base64url',
    );
    expect(
      verifyReplayStamp(SESSION, `${swapped}.${mac}`, TXN, submission, T0 + HOUR / 2, SHORT),
    ).toBeNull();
  });
});
