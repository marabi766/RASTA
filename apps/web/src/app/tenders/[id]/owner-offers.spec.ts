/**
 * @jest-environment node
 */
import { verifyOwnerStamp } from '@/server/tender-owner-replay';
import type { WebSession } from '@/server/session';
import { APPROVAL_ID, OWNER, TENDER_ID, tokenFor } from '@/test/owner-fixtures';

import { ownerCommandOffers } from './owner-offers';

/**
 * The owner's forms, each with a fresh submission whose stamp binds what the
 * page read — so the action sends that, whatever is posted.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const NOW = 1_900_000_000_000;
const SESSION = {
  subject: 'user-1',
  username: 'author',
  organizationId: OWNER,
  accessToken: tokenFor(OWNER, ['ORGANIZATION_ADMIN']),
  accessTokenExpiresAt: Math.floor(NOW / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: Math.floor(NOW / 1000),
} satisfies WebSession;

const verify = (token: string, id: string) => verifyOwnerStamp(SESSION, token, TENDER_ID, id, NOW);

it('a publication’s stamp binds the tender version read and no step', () => {
  const { publication, opening } = ownerCommandOffers(
    SESSION,
    TENDER_ID,
    [{ command: 'PUBLISH', expectedVersion: 4, execute: true }],
    NOW,
  );
  expect(opening).toEqual([]);
  expect(publication).toHaveLength(1);
  const [publish] = publication;
  expect(publish!.execute).toBe(true);
  expect(verify(publish!.submission.replay.token, publish!.submission.id)).toMatchObject({
    command: 'PUBLISH',
    approvalId: null,
    expectedVersion: 4,
  });
});

it('a decision’s stamps bind the step and its version, each its own key', () => {
  const { publication } = ownerCommandOffers(
    SESSION,
    TENDER_ID,
    [
      { command: 'GRANT', approvalId: APPROVAL_ID, expectedVersion: 2 },
      { command: 'REJECT', approvalId: APPROVAL_ID, expectedVersion: 2 },
    ],
    NOW,
  );
  expect(publication.map(({ command }) => command)).toEqual(['GRANT', 'REJECT']);
  expect(new Set(publication.map(({ submission }) => submission.id)).size).toBe(2);
  for (const { command, submission } of publication) {
    expect(verify(submission.replay.token, submission.id)).toMatchObject({
      command,
      approvalId: APPROVAL_ID,
      expectedVersion: 2,
    });
  }
});

it('the opening’s three bind the tender, under the opening, not the publication — a withdrawal the proposal it names too', () => {
  const proposedAt = '2026-10-20T07:00:00.000Z';
  const { publication, opening } = ownerCommandOffers(
    SESSION,
    TENDER_ID,
    [
      { command: 'PROPOSE_OPENING' },
      { command: 'OPEN_BIDS' },
      { command: 'WITHDRAW_PROPOSAL', proposedAt },
    ],
    NOW,
  );
  expect(publication).toEqual([]);
  expect(opening.map(({ command }) => command)).toEqual([
    'PROPOSE_OPENING',
    'OPEN_BIDS',
    'WITHDRAW_PROPOSAL',
  ]);
  for (const { command, submission } of opening) {
    expect(verify(submission.replay.token, submission.id)).toMatchObject({
      command,
      approvalId: null,
      expectedVersion: null,
      // Signed with the form (PR-350 r1 F1): what the withdrawal sends, on every send of it.
      proposedAt: command === 'WITHDRAW_PROPOSAL' ? proposedAt : null,
    });
  }
});

it('a stamp is good only for the submission it was minted with', () => {
  const { opening } = ownerCommandOffers(
    SESSION,
    TENDER_ID,
    [{ command: 'PROPOSE_OPENING' }, { command: 'OPEN_BIDS' }],
    NOW,
  );
  const [propose, open] = opening;
  expect(verify(propose!.submission.replay.token, open!.submission.id)).toBeNull();
});
