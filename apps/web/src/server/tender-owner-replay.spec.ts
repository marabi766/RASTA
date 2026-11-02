/**
 * @jest-environment node
 */
import {
  mintOwnerStamp,
  ownerBindingText,
  verifyOwnerStamp,
  type OwnerTarget,
} from './tender-owner-replay';
import { mintSubmissionId } from './submission';
import type { WebSession } from './session';
import { actingAccessToken } from '@/test/session-token';

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
  accessToken: actingAccessToken('ORG-DEH-0001'),
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

it('binds a withdrawal of the proposal to open to the proposal the page read; no other command names one (PR-350 r1 F1)', () => {
  const proposedAt = '2026-10-20T07:00:00.000Z';
  const opening = { approvalId: null, expectedVersion: null } as const;
  const withdraw = mintOwnerStamp(
    SESSION,
    target({ command: 'WITHDRAW_PROPOSAL', ...opening, proposedAt }),
    SUB,
    NOW,
    ENV,
  );
  // What the action sends — on the first send and on any re-send of the same form, whatever stands by then.
  expect(verifyOwnerStamp(SESSION, withdraw.token, 'TND_1', SUB, NOW, ENV)).toMatchObject({
    command: 'WITHDRAW_PROPOSAL',
    proposedAt,
  });
  expect(
    verifyOwnerStamp(SESSION, withdraw.token, 'TND_1', SUB, NOW + 60_000, ENV)?.proposedAt,
  ).toBe(proposedAt);
  for (const wrong of [
    // A withdrawal naming nothing — a stamp minted before this binding included.
    target({ command: 'WITHDRAW_PROPOSAL', ...opening }),
    target({ command: 'WITHDRAW_PROPOSAL', ...opening, proposedAt: 'not an instant' }),
    target({ command: 'OPEN_BIDS', ...opening, proposedAt }),
    target({ command: 'PROPOSE_OPENING', ...opening, proposedAt }),
    target({ proposedAt }),
  ]) {
    const { token } = mintOwnerStamp(SESSION, wrong, SUB, NOW, ENV);
    expect(verifyOwnerStamp(SESSION, token, 'TND_1', SUB, NOW, ENV)).toBeNull();
  }
  // Every other command's stamp names none.
  const open = mintOwnerStamp(SESSION, target({ command: 'OPEN_BIDS', ...opening }), SUB, NOW, ENV);
  expect(verifyOwnerStamp(SESSION, open.token, 'TND_1', SUB, NOW, ENV)?.proposedAt).toBeNull();
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

describe('a bid’s commands', () => {
  const bid = { expectedVersion: null, bidId: 'BID_A' } as const;
  const scoring = [
    { criterionCode: 'technical', maxScore: 10, passFail: false, expectedRevision: 2 },
  ];
  const award = { justificationRequired: true, execution: { justification: 'آنچه موافقت شد' } };
  const minted = (overrides: Partial<OwnerTarget>) => {
    const target = targetOf(overrides);
    return {
      token: mintOwnerStamp(SESSION, target, SUB, NOW, ENV).token,
      binding: ownerBindingText(target),
    };
  };
  const targetOf = (overrides: Partial<OwnerTarget>) => target(overrides);
  const verified = (overrides: Partial<OwnerTarget>, posted?: unknown) => {
    const { token, binding } = minted(overrides);
    return verifyOwnerStamp(
      SESSION,
      token,
      'TND_1',
      SUB,
      NOW,
      ENV,
      posted === undefined ? binding : posted,
    );
  };

  it('binds a decision on a bid to the bid, a score to its criteria and revisions, an award to its terms', () => {
    expect(verified({ command: 'QUALIFY', ...bid })).toMatchObject({
      command: 'QUALIFY',
      bidId: 'BID_A',
      scoring: null,
      award: null,
    });
    expect(verified({ command: 'SCORE', ...bid, scoring })).toMatchObject({
      bidId: 'BID_A',
      scoring,
    });
    expect(verified({ command: 'AWARD', ...bid, award })).toMatchObject({ bidId: 'BID_A', award });
    expect(verified({ command: 'EVALUATE', expectedVersion: null })).toMatchObject({
      command: 'EVALUATE',
      bidId: null,
    });
    expect(
      verified({ command: 'GRANT_AWARD', approvalId: 'APR_9', expectedVersion: 3 }),
    ).toMatchObject({ approvalId: 'APR_9', expectedVersion: 3, bidId: null });
  });

  it('refuses a bid’s binding that does not fit its command', () => {
    for (const wrong of [
      { command: 'QUALIFY', expectedVersion: null },
      { command: 'DISQUALIFY', ...bid, scoring },
      { command: 'SCORE', ...bid },
      { command: 'AWARD', ...bid },
      { command: 'AWARD', ...bid, award, scoring },
      { command: 'EVALUATE', ...bid },
      { command: 'PUBLISH', bidId: 'BID_A' },
      { command: 'GRANT_AWARD', approvalId: 'APR_9', expectedVersion: 3, bidId: 'BID_A' },
    ] as Partial<OwnerTarget>[]) {
      expect(verified(wrong)).toBeNull();
    }
  });

  it('takes the bound body only as the stamp signed it: changed, missing or for another command, refused', () => {
    const { token, binding } = minted({ command: 'SCORE', ...bid, scoring });
    const changed = binding!.replace('"expectedRevision":2', '"expectedRevision":3');
    for (const posted of [changed, null, '', 'not json', binding + ' ']) {
      expect(verifyOwnerStamp(SESSION, token, 'TND_1', SUB, NOW, ENV, posted)).toBeNull();
    }
    // A body posted beside a stamp that binds none is refused too.
    const qualify = minted({ command: 'QUALIFY', ...bid });
    expect(verifyOwnerStamp(SESSION, qualify.token, 'TND_1', SUB, NOW, ENV, binding)).toBeNull();
    // An award's terms are not a score's criteria, even with a signed digest.
    const awardStamp = minted({ command: 'AWARD', ...bid, award });
    expect(verifyOwnerStamp(SESSION, awardStamp.token, 'TND_1', SUB, NOW, ENV, binding)).toBeNull();
  });

  it('stays a small stamp at the largest body a form can bind: 50 criteria, a 2000-character Persian justification', () => {
    const fifty = Array.from({ length: 50 }, (_, index) => ({
      criterionCode: `${'c'.repeat(61)}${String(index).padStart(3, '0')}`,
      maxScore: 1_000_000,
      passFail: index % 2 === 0,
      expectedRevision: 2_147_483_647,
    }));
    const score = minted({ command: 'SCORE', ...bid, scoring: fifty });
    expect(score.binding!.length).toBeGreaterThan(5000);
    expect(score.token.length).toBeLessThan(1000);
    expect(
      verifyOwnerStamp(SESSION, score.token, 'TND_1', SUB, NOW, ENV, score.binding),
    ).toMatchObject({ scoring: fifty });

    const persian = 'گزینش این پیشنهاد به‌دلیل زمان اجرای کوتاه‌تر '.repeat(60).slice(0, 2000);
    expect(persian).toHaveLength(2000);
    const terms = { justificationRequired: false, execution: { justification: persian } };
    const execute = minted({ command: 'AWARD', ...bid, award: terms });
    expect(execute.token.length).toBeLessThan(1000);
    expect(
      verifyOwnerStamp(SESSION, execute.token, 'TND_1', SUB, NOW, ENV, execute.binding),
    ).toMatchObject({ award: terms });
    // A justification past the DTO's 2000 characters is not a body this server binds.
    const tooLong = { justificationRequired: false, execution: { justification: `${persian}ی` } };
    const refused = minted({ command: 'AWARD', ...bid, award: tooLong });
    expect(
      verifyOwnerStamp(SESSION, refused.token, 'TND_1', SUB, NOW, ENV, refused.binding),
    ).toBeNull();
  });
});
