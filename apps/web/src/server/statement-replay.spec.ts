/**
 * @jest-environment node
 */
import {
  mintStatementStamp,
  statementReplayWindowSeconds,
  verifyStatementStamp,
} from './statement-replay';
import { mintSubmissionId } from './submission';
import type { WebSession } from './session';

/**
 * The statement replay stamp: what it binds a submission to, and until when
 * the same request may be sent — `dispute-replay.spec.ts`'s cases, for the
 * statement commands.
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
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 1_900_000_600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const ENV = { WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS: 1, WEB_CONTRACT_REPLAY_MARGIN_SECONDS: 600 };
const NOW = 1_900_000_000_000;
const SUB = mintSubmissionId(SESSION);
const DECISION = {
  contractId: 'CTR_1',
  statementId: 'STM_1',
  command: 'APPROVE' as const,
  expectedVersion: 2,
  chain: 'TECHNICAL' as const,
  stepOrder: 1,
};

it('the window is the retention less the margin', () => {
  expect(statementReplayWindowSeconds(ENV)).toBe(3000);
});

it('binds a decision to its statement, step, version and command', () => {
  const { token, until } = mintStatementStamp(SESSION, DECISION, SUB, NOW, ENV);
  expect(until).toBe(NOW + 3000 * 1000);
  expect(verifyStatementStamp(SESSION, token, 'CTR_1', 'STM_1', SUB, NOW + 1000, ENV)).toEqual({
    token,
    until,
    command: 'APPROVE',
    statementId: 'STM_1',
    expectedVersion: 2,
    chain: 'TECHNICAL',
    stepOrder: 1,
  });
});

it('a draft’s stamp names the contract and no statement', () => {
  const { token } = mintStatementStamp(
    SESSION,
    { command: 'DRAFT', contractId: 'CTR_1' },
    SUB,
    NOW,
    ENV,
  );
  expect(verifyStatementStamp(SESSION, token, 'CTR_1', null, SUB, NOW, ENV)).toMatchObject({
    command: 'DRAFT',
    statementId: null,
    expectedVersion: null,
  });
  // Never accepted on a statement's form, nor a statement's stamp on the draft form.
  expect(verifyStatementStamp(SESSION, token, 'CTR_1', 'STM_1', SUB, NOW, ENV)).toBeNull();
  const decision = mintStatementStamp(SESSION, DECISION, SUB, NOW, ENV).token;
  expect(verifyStatementStamp(SESSION, decision, 'CTR_1', null, SUB, NOW, ENV)).toBeNull();
});

it.each([
  ['another contract', { contractId: 'CTR_2' }],
  ['another statement', { statementId: 'STM_2' }],
  ['another submission id', { submissionId: mintSubmissionId(SESSION) }],
])('refuses %s', (_name, change) => {
  const { token } = mintStatementStamp(SESSION, DECISION, SUB, NOW, ENV);
  const target = { contractId: 'CTR_1', statementId: 'STM_1', submissionId: SUB, ...change };
  expect(
    verifyStatementStamp(
      SESSION,
      token,
      target.contractId,
      target.statementId,
      target.submissionId,
      NOW,
      ENV,
    ),
  ).toBeNull();
});

it('refuses another login’s stamp', () => {
  const { token } = mintStatementStamp(SESSION, DECISION, SUB, NOW, ENV);
  expect(
    verifyStatementStamp(
      { ...SESSION, subject: 'someone-else' },
      token,
      'CTR_1',
      'STM_1',
      SUB,
      NOW,
      ENV,
    ),
  ).toBeNull();
});

it('refuses past its deadline, and past a retention shortened since', () => {
  const { token } = mintStatementStamp(SESSION, DECISION, SUB, NOW, ENV);
  expect(
    verifyStatementStamp(SESSION, token, 'CTR_1', 'STM_1', SUB, NOW + 3001 * 1000, ENV),
  ).toBeNull();

  const long = { ...ENV, WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS: 24 };
  const issued = mintStatementStamp(SESSION, DECISION, SUB, NOW, long).token;
  const later = NOW + 2 * 60 * 60 * 1000;
  expect(verifyStatementStamp(SESSION, issued, 'CTR_1', 'STM_1', SUB, later, long)).not.toBeNull();
  expect(verifyStatementStamp(SESSION, issued, 'CTR_1', 'STM_1', SUB, later, ENV)).toBeNull();
});

it('refuses anything that is not a stamp', () => {
  for (const token of [null, '', 'x.y', 42]) {
    expect(verifyStatementStamp(SESSION, token, 'CTR_1', 'STM_1', SUB, NOW, ENV)).toBeNull();
  }
});
