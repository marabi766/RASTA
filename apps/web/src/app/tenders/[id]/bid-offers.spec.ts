/**
 * @jest-environment node
 */
import { verifyBidStamp } from '@/server/bid-replay';
import { bidderCallerOf } from '@/server/tender-bids';
import type { WebSession } from '@/server/session';
import {
  BIDDER,
  BID_ID,
  DURING,
  OPEN_TENDER,
  RECEIPT,
  TENDER_ID,
  tokenFor,
} from '@/test/bid-fixtures';

import { bidCommandOffers } from './bid-offers';

/**
 * The forms the tender page draws, each with a fresh submission whose stamp
 * binds what the page read — so the action sends that, whatever is posted.
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
  organizationId: BIDDER,
  accessToken: tokenFor(BIDDER, ['CONTRACTOR']),
  accessTokenExpiresAt: Math.floor(DURING / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: Math.floor(DURING / 1000),
} satisfies WebSession;

const caller = bidderCallerOf(SESSION.accessToken);
const tender = { kind: 'OK' as const, data: OPEN_TENDER };

it('a submission’s stamp binds the tender and no bid', () => {
  const { offered, note } = bidCommandOffers(
    SESSION,
    caller,
    TENDER_ID,
    tender,
    { kind: 'NOT_FOUND' },
    DURING,
  );
  expect(note).toBeNull();
  expect(offered.map(({ command }) => command)).toEqual(['SUBMIT']);
  const [submit] = offered;
  expect(
    verifyBidStamp(
      SESSION,
      submit!.submission.replay.token,
      TENDER_ID,
      submit!.submission.id,
      DURING,
    ),
  ).toMatchObject({ command: 'SUBMIT', bidId: null, expectedRevision: null });
});

it('a replacement’s and a withdrawal’s stamps bind the bid and the revision read, each its own key', () => {
  const { offered } = bidCommandOffers(
    SESSION,
    caller,
    TENDER_ID,
    tender,
    { kind: 'OK', data: { ...RECEIPT, revision: 4 } },
    DURING,
  );
  expect(offered.map(({ command }) => command)).toEqual(['REVISE', 'WITHDRAW']);
  expect(new Set(offered.map(({ submission }) => submission.id)).size).toBe(2);
  for (const { command, submission } of offered) {
    expect(
      verifyBidStamp(SESSION, submission.replay.token, TENDER_ID, submission.id, DURING),
    ).toMatchObject({ command, bidId: BID_ID, expectedRevision: 4 });
  }
});

it('nothing, and nothing minted, for a caller that is no bidder', () => {
  const owner = bidderCallerOf(tokenFor('ORG-DEH-0001', ['ORGANIZATION_ADMIN']));
  expect(bidCommandOffers(SESSION, owner, TENDER_ID, tender, null, DURING)).toEqual({
    offered: [],
    note: null,
  });
});
