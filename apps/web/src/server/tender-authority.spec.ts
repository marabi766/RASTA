/**
 * @jest-environment node
 */
import { AWARD_STEP_ID, AWARDER } from '@/test/evaluation-fixtures';
import { TENDER_ID, jwt } from '@/test/owner-fixtures';

import type { WebSession } from './session';
import {
  INBOX_PAGES,
  authorityOffers,
  fetchAuthoritySteps,
  type AuthorityItem,
  type AuthorityStep,
} from './tender-authority';
import { ownerCallerOf } from './tender-owner';

/**
 * The approval authority of another organization (PR 346 review 1, finding 3):
 * its steps of a tender found in its inbox and read on their own — never the
 * tender — and the decisions it is offered, the services' checks as far as a
 * step shows them.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SESSION = { accessToken: 'access-token-value' } as WebSession;
const REVIEWER_ORG = 'ORG-REVIEW-0001';

function person(roles: string[], uid = 'USR-REVIEWER', org = REVIEWER_ORG) {
  return ownerCallerOf(
    jwt({
      sub: 'kc-subject',
      org_id: org,
      org_ids: [org],
      org_roles: roles.map((role) => `${org}:${role}`),
      rasta_uid: uid,
    }),
  );
}

const STEP: AuthorityStep = {
  id: AWARD_STEP_ID,
  tenderId: TENDER_ID,
  workflowKey: 'tender.award',
  stepOrder: 1,
  status: 'PENDING',
  authorityOrganizationId: REVIEWER_ORG,
  authorityRole: 'ORGANIZATION_ADMIN',
  authorityLabel: 'بازبین (نمونه)',
  requestedAt: '2026-10-22T07:00:00.000Z',
  version: 3,
  project: { title: 'بهسازی راه روستایی' },
  request: {
    requestId: 'TAR_AWARD_1',
    tenderVersion: 8,
    status: 'PENDING',
    requestedBy: AWARDER,
    bid: {
      bidId: 'BID_A',
      bidderOrganizationId: 'ORG-CON-A',
      rank: 1,
      tied: false,
      justification: null,
      standingVerdict: 'ELIGIBLE',
      standingAsOf: '2026-10-22T07:00:00.000Z',
    },
  },
};

const item = (detail: AuthorityItem['detail'], summary: AuthorityStep = STEP): AuthorityItem => ({
  summary,
  detail,
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-1' },
  });
}

afterEach(() => jest.restoreAllMocks());

describe('finding the tender’s steps', () => {
  it('pages through the pending inbox, keeps this tender’s publication and award steps, and reads each on its own', async () => {
    const urls: string[] = [];
    const other = { ...STEP, id: 'APR_OTHER', tenderId: 'TND_OTHER' };
    const project = {
      ...STEP,
      id: 'APR_PROJECT',
      tenderId: null,
      workflowKey: 'project.execution',
    };
    const publication = {
      ...STEP,
      id: 'APR_PUB',
      workflowKey: 'tender.publication',
      request: { ...STEP.request!, bid: null },
    };
    jest.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/v1/approvals?')) {
        return url.includes('cursor=')
          ? json(200, { items: [publication], nextCursor: null, hasMore: false })
          : json(200, { items: [STEP, other, project], nextCursor: 'APR_NEXT', hasMore: true });
      }
      return json(200, url.endsWith('APR_PUB') ? publication : STEP);
    }) as typeof fetch);
    const read = await fetchAuthoritySteps(SESSION, TENDER_ID);
    expect(read.kind === 'OK' && read.data.items.map(({ summary }) => summary.id)).toEqual([
      AWARD_STEP_ID,
      'APR_PUB',
    ]);
    expect(read.kind === 'OK' && read.data.truncated).toBe(false);
    expect(urls).toEqual([
      'http://gateway.test:3000/v1/approvals?status=PENDING&limit=200',
      'http://gateway.test:3000/v1/approvals?status=PENDING&limit=200&cursor=APR_NEXT',
      `http://gateway.test:3000/v1/approvals/${AWARD_STEP_ID}`,
      'http://gateway.test:3000/v1/approvals/APR_PUB',
    ]);
    // The tender itself is never asked for.
    expect(urls.some((url) => url.includes('/v1/tenders/'))).toBe(false);
  });

  it('a refused detail is kept as refused; one for another step or tender is not this step', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((async (input: RequestInfo | URL) =>
        String(input).includes('/v1/approvals?')
          ? json(200, { items: [STEP], nextCursor: null, hasMore: false })
          : json(200, { ...STEP, tenderId: 'TND_OTHER' })) as typeof fetch);
    const read = await fetchAuthoritySteps(SESSION, TENDER_ID);
    expect(read.kind === 'OK' && read.data.items[0]?.detail.kind).toBe('MALFORMED');
    jest.restoreAllMocks();
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((async (input: RequestInfo | URL) =>
        String(input).includes('/v1/approvals?')
          ? json(200, { items: [STEP], nextCursor: null, hasMore: false })
          : json(403, { code: 'FORBIDDEN', message: 'x' })) as typeof fetch);
    const refused = await fetchAuthoritySteps(SESSION, TENDER_ID);
    expect(refused.kind === 'OK' && refused.data.items[0]?.detail).toEqual({ kind: 'FORBIDDEN' });
  });

  it('an inbox the caller may not read is its own outcome; one longer than the pages looked through says so', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((async () =>
        json(403, { code: 'FORBIDDEN', message: 'x' })) as typeof fetch);
    expect(await fetchAuthoritySteps(SESSION, TENDER_ID)).toEqual({ kind: 'FORBIDDEN' });
    jest.restoreAllMocks();
    let pages = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      pages += 1;
      return json(200, { items: [], nextCursor: `C${pages}`, hasMore: true });
    }) as typeof fetch);
    const long = await fetchAuthoritySteps(SESSION, TENDER_ID);
    expect(pages).toBe(INBOX_PAGES);
    expect(long).toEqual({ kind: 'OK', data: { items: [], truncated: true } });
  });
});

describe('what an authority is offered — the services’ checks as far as the step shows them', () => {
  it('the step’s organization with its exact role decides: grant and reject, for an award as for a publication', () => {
    expect(
      authorityOffers(person(['ORGANIZATION_ADMIN']), item({ kind: 'OK', data: STEP })),
    ).toEqual({
      offers: [
        { command: 'GRANT_AWARD', approvalId: AWARD_STEP_ID, expectedVersion: 3 },
        { command: 'REJECT_AWARD', approvalId: AWARD_STEP_ID, expectedVersion: 3 },
      ],
      notes: [],
    });
    const publication = { ...STEP, workflowKey: 'tender.publication' };
    expect(
      authorityOffers(
        person(['ORGANIZATION_ADMIN']),
        item({ kind: 'OK', data: publication }),
      ).offers.map(({ command }) => command),
    ).toEqual(['GRANT', 'REJECT']);
  });

  it('the person who made the request is offered only the rejection', () => {
    expect(
      authorityOffers(person(['ORGANIZATION_ADMIN'], AWARDER), item({ kind: 'OK', data: STEP })),
    ).toEqual({
      offers: [{ command: 'REJECT_AWARD', approvalId: AWARD_STEP_ID, expectedVersion: 3 }],
      notes: ['OWN_REQUEST'],
    });
  });

  it('another organization or role, the oversight role, an excluded role on an award, or a step decided: nothing', () => {
    const none = { offers: [], notes: ['NOT_DECIDABLE'] };
    const ok = item({ kind: 'OK', data: STEP });
    expect(authorityOffers(person(['ORGANIZATION_ADMIN'], 'U', 'ORG-ELSEWHERE'), ok)).toEqual(none);
    expect(authorityOffers(person(['FLEET_MANAGER']), ok)).toEqual(none);
    expect(authorityOffers(person(['ORGANIZATION_ADMIN', 'AUDITOR']), ok)).toEqual(none);
    expect(authorityOffers(person(['ORGANIZATION_ADMIN', 'CONTRACTOR']), ok)).toEqual(none);
    expect(
      authorityOffers(
        person(['ORGANIZATION_ADMIN']),
        item({ kind: 'OK', data: { ...STEP, status: 'GRANTED' } }),
      ),
    ).toEqual(none);
    expect(
      authorityOffers(
        person(['ORGANIZATION_ADMIN']),
        item({ kind: 'OK', data: { ...STEP, request: { ...STEP.request!, status: 'STALE' } } }),
      ),
    ).toEqual(none);
  });

  it('a step the service refuses to show is refused to decide; one unread is not offered', () => {
    expect(authorityOffers(person(['ORGANIZATION_ADMIN']), item({ kind: 'FORBIDDEN' }))).toEqual({
      offers: [],
      notes: ['STEP_REFUSED'],
    });
    expect(
      authorityOffers(
        person(['ORGANIZATION_ADMIN']),
        item({ kind: 'UNAVAILABLE', status: 503, correlationId: 'c' }),
      ),
    ).toEqual({ offers: [], notes: ['STEP_UNREAD'] });
  });
});
