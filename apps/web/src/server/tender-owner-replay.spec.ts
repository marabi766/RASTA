/**
 * @jest-environment node
 */
import { mintOwnerStamp, verifyOwnerStamp, type OwnerTarget } from './tender-owner-replay';
import { mintSubmissionId } from './submission';
import type { WebSession } from './session';

/** The owner's replay stamp: what it binds a command to, and until when. */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SESSION = {
  subject: 'user-1',
  username: 'author',
  organizationId: 'ORG-DEH-0001',
  accessToken: 'access-token-value',
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
const target = (overrides: Partial<OwnerTarget>): OwnerTarget => ({
  tenderId: 'TND_1',
  command: 'PUBLISH',
  approvalId: null,
  expectedVersion: 4,
  ...overrides,
});

it('binds a publication to its tender and version, a decision to its step and version', () => {
  const publish = mintOwnerStamp(SESSION, target({}), SUB, NOW, ENV);
  expect(verifyOwnerStamp(SESSION, publish.token, 'TND_1', SUB, NOW, ENV)).toMatchObject({
    command: 'PUBLISH',
    approvalId: null,
    expectedVersion: 4,
  });
  const decide = mintOwnerStamp(
    SESSION,
    target({ command: 'REJECT', approvalId: 'APR_1', expectedVersion: 7 }),
    SUB,
    NOW,
    ENV,
  );
  expect(verifyOwnerStamp(SESSION, decide.token, 'TND_1', SUB, NOW, ENV)).toMatchObject({
    command: 'REJECT',
    approvalId: 'APR_1',
    expectedVersion: 7,
  });
  const open = mintOwnerStamp(
    SESSION,
    target({ command: 'OPEN_BIDS', expectedVersion: null }),
    SUB,
    NOW,
    ENV,
  );
  expect(verifyOwnerStamp(SESSION, open.token, 'TND_1', SUB, NOW, ENV)).toMatchObject({
    command: 'OPEN_BIDS',
    approvalId: null,
    expectedVersion: null,
  });
});

it('refuses a binding that does not fit its command', () => {
  for (const wrong of [
    target({ expectedVersion: null }),
    target({ approvalId: 'APR_1' }),
    target({ command: 'GRANT', approvalId: null, expectedVersion: 7 }),
    target({ command: 'PROPOSE_OPENING', expectedVersion: 3 }),
  ]) {
    const { token } = mintOwnerStamp(SESSION, wrong, SUB, NOW, ENV);
    expect(verifyOwnerStamp(SESSION, token, 'TND_1', SUB, NOW, ENV)).toBeNull();
  }
});

it('refuses another tender, another submission, another login, and a passed deadline', () => {
  const { token } = mintOwnerStamp(SESSION, target({}), SUB, NOW, ENV);
  expect(verifyOwnerStamp(SESSION, token, 'TND_2', SUB, NOW, ENV)).toBeNull();
  expect(verifyOwnerStamp(SESSION, token, 'TND_1', mintSubmissionId(SESSION), NOW, ENV)).toBeNull();
  expect(
    verifyOwnerStamp({ ...SESSION, csrfToken: 'another' }, token, 'TND_1', SUB, NOW, ENV),
  ).toBeNull();
  expect(verifyOwnerStamp(SESSION, token, 'TND_1', SUB, NOW + 3001 * 1000, ENV)).toBeNull();
});
