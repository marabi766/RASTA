/**
 * @jest-environment node
 */
import { bidReplayWindowSeconds, mintBidStamp, verifyBidStamp } from './bid-replay';
import { mintSubmissionId } from './submission';
import type { WebSession } from './session';
import { actingAccessToken } from '@/test/session-token';

/**
 * The bid replay stamp: what it binds a submission to — the tender, the
 * command, and for a replacement or a withdrawal the bid and the revision the
 * page showed — and until when the same request may be sent.
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
  username: 'contractor',
  organizationId: 'ORG-CON-0001',
  accessToken: actingAccessToken('ORG-CON-0001'),
  accessTokenExpiresAt: 1_900_000_600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const ENV = {
  WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: 1,
  WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS: 600,
};
const NOW = 1_900_000_000_000;
const SUB = mintSubmissionId(SESSION);
const REVISE = {
  tenderId: 'TND_1',
  command: 'REVISE' as const,
  bidId: 'BID_1',
  expectedRevision: 2,
};
const SUBMIT = {
  tenderId: 'TND_1',
  command: 'SUBMIT' as const,
  bidId: null,
  expectedRevision: null,
};

it('the window is the retention less the margin', () => {
  expect(bidReplayWindowSeconds(ENV)).toBe(3000);
});

it('binds a replacement to its tender, bid, revision and command', () => {
  const { token, until } = mintBidStamp(SESSION, REVISE, SUB, NOW, ENV);
  expect(until).toBe(NOW + 3000 * 1000);
  expect(verifyBidStamp(SESSION, token, 'TND_1', SUB, NOW + 1000, ENV)).toEqual({
    token,
    until,
    command: 'REVISE',
    bidId: 'BID_1',
    expectedRevision: 2,
  });
});

it('binds a submission to its tender, with no bid and no revision', () => {
  const { token } = mintBidStamp(SESSION, SUBMIT, SUB, NOW, ENV);
  expect(verifyBidStamp(SESSION, token, 'TND_1', SUB, NOW, ENV)).toMatchObject({
    command: 'SUBMIT',
    bidId: null,
    expectedRevision: null,
  });
});

it('refuses another tender, another submission, another login and a token that is not one', () => {
  const { token } = mintBidStamp(SESSION, REVISE, SUB, NOW, ENV);
  expect(verifyBidStamp(SESSION, token, 'TND_2', SUB, NOW, ENV)).toBeNull();
  expect(verifyBidStamp(SESSION, token, 'TND_1', mintSubmissionId(SESSION), NOW, ENV)).toBeNull();
  expect(
    verifyBidStamp({ ...SESSION, csrfToken: 'another-login' }, token, 'TND_1', SUB, NOW, ENV),
  ).toBeNull();
  expect(verifyBidStamp(SESSION, 'not-a-stamp', 'TND_1', SUB, NOW, ENV)).toBeNull();
  expect(verifyBidStamp(SESSION, undefined, 'TND_1', SUB, NOW, ENV)).toBeNull();
});

it('refuses a command whose binding does not fit it', () => {
  const submitWithBid = mintBidStamp(SESSION, { ...SUBMIT, bidId: 'BID_1' }, SUB, NOW, ENV);
  expect(verifyBidStamp(SESSION, submitWithBid.token, 'TND_1', SUB, NOW, ENV)).toBeNull();
  const reviseWithoutRevision = mintBidStamp(
    SESSION,
    { ...REVISE, expectedRevision: null },
    SUB,
    NOW,
    ENV,
  );
  expect(verifyBidStamp(SESSION, reviseWithoutRevision.token, 'TND_1', SUB, NOW, ENV)).toBeNull();
});

it('ends at its signed expiry, and sooner when the window is shortened afterwards', () => {
  const { token } = mintBidStamp(SESSION, REVISE, SUB, NOW, ENV);
  expect(verifyBidStamp(SESSION, token, 'TND_1', SUB, NOW + 3000 * 1000, ENV)).not.toBeNull();
  expect(verifyBidStamp(SESSION, token, 'TND_1', SUB, NOW + 3001 * 1000, ENV)).toBeNull();
  const shorter = { ...ENV, WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS: 1800 };
  expect(verifyBidStamp(SESSION, token, 'TND_1', SUB, NOW + 1801 * 1000, shorter)).toBeNull();
});
