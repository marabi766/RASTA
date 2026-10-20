/**
 * @jest-environment node
 */
import {
  OWNER_REFUSAL_FALLBACK,
  OPENING_REFUSAL_TEXT,
  PUBLICATION_REFUSAL_TEXT,
} from '@/lib/tender-owner-fields';
import {
  APPROVAL_ID,
  APPROVED_REQUEST,
  AUTHOR,
  CLOSED_TENDER,
  DRAFT_TENDER,
  OPENED_BIDS,
  OWNER,
  PENDING_REQUEST,
  TENDER_ID,
  UNOPENED_BIDS,
  jwt,
} from '@/test/owner-fixtures';

import {
  canOpenBids,
  canPublish,
  decidableStep,
  isOpeningOnly,
  mayGrant,
  openingOnlyOffers,
  fetchOwnerBids,
  fetchPublicationRequest,
  issueOwnerCommand,
  outcomeOf,
  ownerCallerOf,
  ownerOffers,
  ownerRequest,
  readsOwnerBids,
  type OwnerBinding,
  type OwnerState,
} from './tender-owner';
import type { WebSession } from './session';

/**
 * The owner module: what it reads, who it offers each form to — the copy of
 * construction-service's checks pinned by `tender-owner.contract.spec.ts` —
 * what each command sends, and what every answer becomes.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SESSION = { accessToken: 'access-token-value' } as WebSession;
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const SETTINGS = {
  WEB_PROJECT_ROLES: ['ORGANIZATION_ADMIN'],
  WEB_PROJECT_READER_ROLES: [] as string[],
  WEB_TENDER_OPEN_ROLES: [] as string[],
};
const NOW = Date.parse('2026-10-18T12:00:00.000Z');

/** A person acting for `org` with `roles`, under user id `uid` (none: only a subject). */
function person(
  roles: string[],
  uid: string | null = 'USR-OTHER',
  org = OWNER,
  realm: string[] = [],
) {
  return ownerCallerOf(
    jwt({
      sub: 'kc-subject',
      org_id: org,
      org_ids: [org],
      org_roles: roles.map((role) => `${org}:${role}`),
      realm_access: { roles: realm },
      ...(uid ? { rasta_uid: uid } : {}),
    }),
  );
}

const ADMIN = person(['ORGANIZATION_ADMIN']);

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-1', ...headers },
  });
}

function problem(status: number, code: string, reasons: { path: string; code: string }[] = []) {
  return jsonResponse(status, {
    code,
    message: 'An English sentence the page must never show',
    correlationId: 'corr-1',
    ...(reasons.length ? { details: reasons.map((d) => ({ ...d, message: 'English' })) } : {}),
  });
}

afterEach(() => jest.restoreAllMocks());

describe('reading', () => {
  it('the newest publication request, by its workflow, one at a time', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      jsonResponse(200, {
        items: [PENDING_REQUEST],
        nextCursor: null,
        hasMore: false,
      })) as unknown as typeof fetch);
    expect(await fetchPublicationRequest(SESSION, TENDER_ID)).toEqual({
      kind: 'OK',
      data: PENDING_REQUEST,
    });
    expect(String(spy.mock.calls[0]?.[0])).toBe(
      `http://gateway.test:3000/v1/tenders/${TENDER_ID}/approvals?workflowKey=tender.publication&limit=1`,
    );
  });

  it('none ever made is null; another tender’s request is malformed', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce((async () =>
        jsonResponse(200, { items: [] })) as unknown as typeof fetch)
      .mockImplementationOnce((async () =>
        jsonResponse(200, {
          items: [{ ...PENDING_REQUEST, tenderId: 'TND_OTHER' }],
        })) as unknown as typeof fetch);
    expect(await fetchPublicationRequest(SESSION, TENDER_ID)).toEqual({ kind: 'OK', data: null });
    expect(await fetchPublicationRequest(SESSION, TENDER_ID)).toMatchObject({ kind: 'MALFORMED' });
  });

  it('the owner’s bids keep prices as decimal strings and refuse a number', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce((async () =>
        jsonResponse(200, OPENED_BIDS)) as unknown as typeof fetch)
      .mockImplementationOnce((async () =>
        jsonResponse(200, {
          ...OPENED_BIDS,
          bids: [
            {
              ...OPENED_BIDS.bids[0],
              content: { ...OPENED_BIDS.bids[0]!.content, priceMinor: 42 },
            },
          ],
        })) as unknown as typeof fetch);
    expect(await fetchOwnerBids(SESSION, TENDER_ID)).toEqual({ kind: 'OK', data: OPENED_BIDS });
    expect(await fetchOwnerBids(SESSION, TENDER_ID)).toMatchObject({ kind: 'MALFORMED' });
  });
});

describe('who may publish — assertCanWrite and @RequirePlatformUserId', () => {
  it('the project roles, and SYSTEM_ADMIN acting for the organization', () => {
    expect(canPublish(ADMIN, SETTINGS)).toBe(true);
    expect(canPublish(person(['OPERATOR'], 'U', OWNER, ['SYSTEM_ADMIN']), SETTINGS)).toBe(true);
  });

  it('never AUDITOR, never without a project role or a platform user id', () => {
    expect(canPublish(person(['ORGANIZATION_ADMIN', 'AUDITOR']), SETTINGS)).toBe(false);
    expect(canPublish(person(['FLEET_MANAGER']), SETTINGS)).toBe(false);
    expect(canPublish(person(['ORGANIZATION_ADMIN'], null), SETTINGS)).toBe(false);
    expect(canPublish(ownerCallerOf('not-a-token'), SETTINGS)).toBe(false);
  });
});

describe('who may open — assertCanOpenBids', () => {
  it('the opening roles, else the project roles', () => {
    expect(canOpenBids(ADMIN, SETTINGS)).toBe(true);
    const configured = { ...SETTINGS, WEB_TENDER_OPEN_ROLES: ['FLEET_MANAGER'] };
    expect(canOpenBids(ADMIN, configured)).toBe(false);
    expect(canOpenBids(person(['FLEET_MANAGER']), configured)).toBe(true);
  });

  it('never SYSTEM_ADMIN, CONTRACTOR or AUDITOR, whatever else is held', () => {
    for (const roles of [
      ['ORGANIZATION_ADMIN', 'CONTRACTOR'],
      ['ORGANIZATION_ADMIN', 'AUDITOR'],
    ]) {
      expect(canOpenBids(person(roles), SETTINGS)).toBe(false);
    }
    expect(
      canOpenBids(person(['ORGANIZATION_ADMIN'], 'U', OWNER, ['SYSTEM_ADMIN']), SETTINGS),
    ).toBe(false);
    expect(canOpenBids(person(['ORGANIZATION_ADMIN'], null), SETTINGS)).toBe(false);
  });

  it('the bids are read only for an opener, once the tender is past its draft', () => {
    expect(readsOwnerBids(ADMIN, 'DRAFT', SETTINGS)).toBe(false);
    expect(readsOwnerBids(ADMIN, 'PUBLISHED', SETTINGS)).toBe(true);
    expect(readsOwnerBids(ADMIN, 'EVALUATING', SETTINGS)).toBe(true);
    expect(readsOwnerBids(person(['ORGANIZATION_ADMIN', 'AUDITOR']), 'CLOSED', SETTINGS)).toBe(
      false,
    );
  });
});

describe('an opener who may not read the tender — `assertCanOpenBids` without `assertCanRead`', () => {
  const OPENING_ONLY = { ...SETTINGS, WEB_TENDER_OPEN_ROLES: ['FLEET_MANAGER'] };
  const fleet = person(['FLEET_MANAGER']);

  it('is told apart from an owner who reads the tender, and from a reader who does not open', () => {
    expect(isOpeningOnly(fleet, OPENING_ONLY)).toBe(true);
    expect(isOpeningOnly(person(['ORGANIZATION_ADMIN']), OPENING_ONLY)).toBe(false);
    expect(
      isOpeningOnly(fleet, { ...OPENING_ONLY, WEB_PROJECT_READER_ROLES: ['FLEET_MANAGER'] }),
    ).toBe(false);
    expect(isOpeningOnly(fleet, SETTINGS)).toBe(false);
    expect(isOpeningOnly(person(['FLEET_MANAGER', 'AUDITOR']), OPENING_ONLY)).toBe(false);
  });

  it('is offered the opening’s three while the bids are not opened, and nothing after', () => {
    expect(openingOnlyOffers(fleet, { kind: 'OK', data: UNOPENED_BIDS }, OPENING_ONLY)).toEqual([
      { command: 'PROPOSE_OPENING' },
      { command: 'OPEN_BIDS' },
      { command: 'WITHDRAW_PROPOSAL' },
    ]);
    expect(openingOnlyOffers(fleet, { kind: 'OK', data: OPENED_BIDS }, OPENING_ONLY)).toEqual([]);
    expect(openingOnlyOffers(fleet, { kind: 'NOT_FOUND' }, OPENING_ONLY)).toEqual([]);
    expect(openingOnlyOffers(fleet, { kind: 'OK', data: UNOPENED_BIDS }, SETTINGS)).toEqual([]);
  });
});

describe('who decides the publication — assertIsAuthority; the grant never the requester’s', () => {
  it('the step’s organization and its exact role, on a pending request of this version', () => {
    expect(decidableStep(ADMIN, PENDING_REQUEST, 4)?.approvalId).toBe(APPROVAL_ID);
  });

  it('not another organization; not another role; not AUDITOR', () => {
    expect(
      decidableStep(person(['ORGANIZATION_ADMIN'], 'U', 'ORG-DEH-0002'), PENDING_REQUEST, 4),
    ).toBeNull();
    expect(decidableStep(person(['FLEET_MANAGER']), PENDING_REQUEST, 4)).toBeNull();
    expect(decidableStep(person(['ORGANIZATION_ADMIN', 'AUDITOR']), PENDING_REQUEST, 4)).toBeNull();
  });

  it('the requester is still the authority — a rejection is theirs — but never grants', () => {
    const author = person(['ORGANIZATION_ADMIN'], AUTHOR);
    expect(decidableStep(author, PENDING_REQUEST, 4)?.approvalId).toBe(APPROVAL_ID);
    expect(mayGrant(author, PENDING_REQUEST)).toBe(false);
    expect(mayGrant(ADMIN, PENDING_REQUEST)).toBe(true);
  });

  it('the requester recognised by the subject when the token names no platform user', () => {
    const bySubject = { ...PENDING_REQUEST, requestedBy: 'kc-subject' };
    expect(mayGrant(person(['ORGANIZATION_ADMIN'], null), bySubject)).toBe(false);
  });

  it('nobody whose identity the token does not name grants: the requester cannot be ruled out', () => {
    expect(mayGrant({ ...ADMIN, actorId: null }, PENDING_REQUEST)).toBe(false);
  });

  it('nothing on a request the tender has moved past: any decision would end it stale', () => {
    expect(decidableStep(ADMIN, PENDING_REQUEST, 5)).toBeNull();
  });

  it('nothing once the request is approved, rejected or used', () => {
    expect(decidableStep(ADMIN, APPROVED_REQUEST, 4)).toBeNull();
    expect(decidableStep(ADMIN, null, 4)).toBeNull();
  });
});

describe('which forms are offered', () => {
  const state = (overrides: Partial<OwnerState> = {}): OwnerState => ({
    tender: DRAFT_TENDER,
    publication: { kind: 'OK', data: null },
    step: null,
    ...overrides,
  });

  it('a draft with no request: the publication, asked for on the version read', () => {
    expect(ownerOffers(ADMIN, state(), SETTINGS, NOW)).toEqual({
      offers: [{ command: 'PUBLISH', expectedVersion: 4, execute: false }],
      notes: [],
    });
  });

  it('approved on this very version: the same command executes', () => {
    const offers = ownerOffers(
      ADMIN,
      state({ publication: { kind: 'OK', data: APPROVED_REQUEST } }),
      SETTINGS,
      NOW,
    );
    expect(offers.offers).toEqual([{ command: 'PUBLISH', expectedVersion: 4, execute: true }]);
    const moved = ownerOffers(
      ADMIN,
      state({
        tender: { ...DRAFT_TENDER, version: 5 },
        publication: { kind: 'OK', data: APPROVED_REQUEST },
      }),
      SETTINGS,
      NOW,
    );
    expect(moved.offers).toEqual([{ command: 'PUBLISH', expectedVersion: 5, execute: false }]);
  });

  it('pending: the authority decides on the step’s version; the requester is told it waits', () => {
    const step = {
      kind: 'OK' as const,
      data: {
        id: APPROVAL_ID,
        tenderId: TENDER_ID,
        workflowKey: 'tender.publication',
        status: 'PENDING',
        authorityOrganizationId: OWNER,
        authorityRole: 'ORGANIZATION_ADMIN',
        version: 7,
      },
    };
    expect(
      ownerOffers(
        ADMIN,
        state({ publication: { kind: 'OK', data: PENDING_REQUEST }, step }),
        SETTINGS,
        NOW,
      ),
    ).toEqual({
      offers: [
        { command: 'GRANT', approvalId: APPROVAL_ID, expectedVersion: 7 },
        { command: 'REJECT', approvalId: APPROVAL_ID, expectedVersion: 7 },
      ],
      notes: ['PUBLICATION_PENDING'],
    });
    // The requester, the authority of the step too: told it waits, offered the rejection only.
    const author = person(['ORGANIZATION_ADMIN'], AUTHOR);
    expect(
      ownerOffers(
        author,
        state({ publication: { kind: 'OK', data: PENDING_REQUEST }, step }),
        SETTINGS,
        NOW,
      ),
    ).toEqual({
      offers: [{ command: 'REJECT', approvalId: APPROVAL_ID, expectedVersion: 7 }],
      notes: ['OWN_REQUEST'],
    });
  });

  it('pending on an earlier version: a fresh request is offered, and no decision', () => {
    const moved = { ...DRAFT_TENDER, version: 5 };
    expect(
      ownerOffers(
        ADMIN,
        state({ tender: moved, publication: { kind: 'OK', data: PENDING_REQUEST } }),
        SETTINGS,
        NOW,
      ),
    ).toEqual({
      offers: [{ command: 'PUBLISH', expectedVersion: 5, execute: false }],
      notes: ['REQUEST_BEHIND'],
    });
  });

  it('requests that cannot be read, or a step that cannot, offer nothing and say so', () => {
    expect(
      ownerOffers(
        ADMIN,
        state({ publication: { kind: 'UNAVAILABLE', status: 503, correlationId: 'c' } }),
        SETTINGS,
        NOW,
      ),
    ).toEqual({ offers: [], notes: ['REQUESTS_UNREAD'] });
    expect(
      ownerOffers(
        ADMIN,
        state({
          publication: { kind: 'OK', data: PENDING_REQUEST },
          step: { kind: 'MALFORMED', correlationId: 'c' },
        }),
        SETTINGS,
        NOW,
      ).notes,
    ).toEqual(['PUBLICATION_PENDING', 'STEP_UNREAD']);
  });

  it('a closed tender: the opening’s three, to an opener only', () => {
    expect(
      ownerOffers(ADMIN, state({ tender: CLOSED_TENDER, publication: null }), SETTINGS, NOW).offers,
    ).toEqual([
      { command: 'PROPOSE_OPENING' },
      { command: 'OPEN_BIDS' },
      { command: 'WITHDRAW_PROPOSAL' },
    ]);
    const auditor = person(['ORGANIZATION_ADMIN', 'AUDITOR']);
    expect(
      ownerOffers(auditor, state({ tender: CLOSED_TENDER, publication: null }), SETTINGS, NOW)
        .offers,
    ).toEqual([]);
  });

  it('published past its deadline: the sweeper closes it, no form does', () => {
    const published = { ...CLOSED_TENDER, status: 'PUBLISHED' };
    expect(
      ownerOffers(ADMIN, state({ tender: published, publication: null }), SETTINGS, NOW),
    ).toEqual({
      offers: [],
      notes: [],
    });
    const late = Date.parse(published.bidClosingAt!) + 1;
    expect(
      ownerOffers(ADMIN, state({ tender: published, publication: null }), SETTINGS, late),
    ).toEqual({
      offers: [],
      notes: ['AWAITING_CLOSE'],
    });
  });

  it('nothing to someone who neither publishes nor opens', () => {
    expect(ownerOffers(person(['FLEET_MANAGER']), state(), SETTINGS, NOW)).toEqual({
      offers: [],
      notes: [],
    });
  });
});

describe('what each command sends — from the stamp', () => {
  const bind = (
    command: OwnerBinding['command'],
    approvalId: string | null,
    expectedVersion: number | null,
  ): OwnerBinding => ({ command, approvalId, expectedVersion });

  it('a publication is the version read', () => {
    expect(ownerRequest(TENDER_ID, bind('PUBLISH', null, 4), {})).toMatchObject({
      path: `/v1/tenders/${TENDER_ID}/publish`,
      body: { expectedVersion: 4 },
    });
  });

  it('a decision is the step’s version and the decision; a rejection its reason', () => {
    expect(ownerRequest(TENDER_ID, bind('GRANT', APPROVAL_ID, 7), {})).toMatchObject({
      path: `/v1/approvals/${APPROVAL_ID}/decision`,
      body: { expectedVersion: 7, decision: 'GRANT' },
    });
    expect(
      ownerRequest(TENDER_ID, bind('REJECT', APPROVAL_ID, 7), { reason: 'معیارها کامل نیست' }),
    ).toMatchObject({
      path: `/v1/approvals/${APPROVAL_ID}/decision`,
      body: { expectedVersion: 7, decision: 'REJECT', reason: 'معیارها کامل نیست' },
    });
  });

  it('the opening’s three carry nothing', () => {
    expect(ownerRequest(TENDER_ID, bind('PROPOSE_OPENING', null, null), {})?.path).toBe(
      `/v1/tenders/${TENDER_ID}/open-bids/proposal`,
    );
    expect(ownerRequest(TENDER_ID, bind('OPEN_BIDS', null, null), {})).toMatchObject({
      path: `/v1/tenders/${TENDER_ID}/open-bids`,
      body: {},
    });
    expect(ownerRequest(TENDER_ID, bind('WITHDRAW_PROPOSAL', null, null), {})?.path).toBe(
      `/v1/tenders/${TENDER_ID}/open-bids/proposal/withdraw`,
    );
  });

  it('a binding that does not fit its command carries nothing', () => {
    expect(ownerRequest(TENDER_ID, bind('PUBLISH', null, null), {})).toBeNull();
    expect(ownerRequest(TENDER_ID, bind('GRANT', null, 7), {})).toBeNull();
    expect(ownerRequest(TENDER_ID, bind('REJECT', APPROVAL_ID, 7), {})).toBeNull();
    expect(
      ownerRequest(TENDER_ID, bind('GRANT', APPROVAL_ID, 7), { reason: 'a reason here' }),
    ).toBeNull();
    expect(ownerRequest(TENDER_ID, bind('OPEN_BIDS', null, 3), {})).toBeNull();
  });
});

describe('what every answer becomes', () => {
  const send = (binding: OwnerBinding, fetchImpl: jest.Mock, reason: string | null = null) =>
    issueOwnerCommand(
      SESSION,
      TENDER_ID,
      binding,
      ownerRequest(TENDER_ID, binding, reason === null ? {} : { reason })!,
      SUBMISSION,
      fetchImpl as unknown as typeof fetch,
    );
  const publish: OwnerBinding = { command: 'PUBLISH', approvalId: null, expectedVersion: 4 };
  const grant: OwnerBinding = { command: 'GRANT', approvalId: APPROVAL_ID, expectedVersion: 7 };
  const open: OwnerBinding = { command: 'OPEN_BIDS', approvalId: null, expectedVersion: null };

  it('a publication answers its request (202) or the published tender (200) — both confirmed, told apart', async () => {
    const asked = await send(
      publish,
      jest.fn(async () => jsonResponse(202, PENDING_REQUEST)),
    );
    expect(asked.kind).toBe('CREATED');
    expect(asked.kind === 'CREATED' && outcomeOf('PUBLISH', asked.data)).toBe('REQUESTED');
    const done = await send(
      publish,
      jest.fn(async () => jsonResponse(200, { id: TENDER_ID, status: 'PUBLISHED', version: 5 })),
    );
    expect(done.kind === 'CREATED' && outcomeOf('PUBLISH', done.data)).toBe('PUBLISHED');
    // A request for another version, another tender or another workflow is not this publication's.
    for (const other of [
      { tenderVersion: 3 },
      { tenderId: 'TND_OTHER' },
      { workflowKey: 'tender.award' },
    ]) {
      expect(
        await send(
          publish,
          jest.fn(async () => jsonResponse(202, { ...PENDING_REQUEST, ...other })),
        ),
      ).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
    }
  });

  it('every reason a publication fails for is said in fixed words, all of them', async () => {
    const refused = await send(
      publish,
      jest.fn(async () =>
        problem(422, 'BUSINESS_RULE_VIOLATION', [
          { path: 'publication', code: 'CRITERIA_REQUIRED' },
          { path: 'publication', code: 'INVITATION_REQUIRED' },
        ]),
      ),
    );
    expect(refused).toMatchObject({
      kind: 'INVALID',
      message: `${PUBLICATION_REFUSAL_TEXT.CRITERIA_REQUIRED} ${PUBLICATION_REFUSAL_TEXT.INVITATION_REQUIRED}`,
    });
    expect(JSON.stringify(refused)).not.toContain('English');
  });

  it('a stale approval and a moved tender are said as such', async () => {
    const stale = await send(
      publish,
      jest.fn(async () => problem(409, 'CONFLICT', [{ path: 'approval', code: 'APPROVAL_STALE' }])),
    );
    expect(stale.kind === 'INVALID' && stale.message).toMatch(/نسخهٔ دیگری از مناقصه/);
    const moved = await send(
      grant,
      jest.fn(async () => problem(409, 'OPTIMISTIC_LOCK_FAILED')),
    );
    expect(moved.kind === 'INVALID' && moved.message).toMatch(/تغییر کرده است/);
  });

  it('a decision is confirmed only by the step it decided', async () => {
    const step = {
      id: APPROVAL_ID,
      tenderId: TENDER_ID,
      workflowKey: 'tender.publication',
      authorityOrganizationId: OWNER,
      authorityRole: 'ORGANIZATION_ADMIN',
      version: 8,
    };
    expect(
      await send(
        grant,
        jest.fn(async () => jsonResponse(200, { ...step, status: 'GRANTED' })),
      ),
    ).toMatchObject({ kind: 'CREATED' });
    for (const other of [
      { status: 'PENDING' },
      { status: 'GRANTED', id: 'APR_OTHER' },
      { status: 'GRANTED', tenderId: 'TND_OTHER' },
    ]) {
      expect(
        await send(
          grant,
          jest.fn(async () => jsonResponse(200, { ...step, ...other })),
        ),
      ).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
    }
  });

  it('the requester approving their own request: a 403, its words chosen by the form', async () => {
    expect(
      await send(
        grant,
        jest.fn(async () => problem(403, 'FORBIDDEN')),
      ),
    ).toEqual({
      kind: 'FORBIDDEN',
      correlationId: expect.any(String),
    });
  });

  it('the two people of an opening are said in fixed words; an opening already done is confirmed', async () => {
    for (const reason of ['SECOND_PERSON_REQUIRED', 'PROPOSAL_REQUIRED', 'NOT_CLOSED']) {
      const refused = await send(
        open,
        jest.fn(async () =>
          problem(422, 'BUSINESS_RULE_VIOLATION', [{ path: 'opening', code: reason }]),
        ),
      );
      expect(refused).toMatchObject({ kind: 'INVALID', message: OPENING_REFUSAL_TEXT[reason] });
    }
    const opened = {
      tenderId: TENDER_ID,
      status: 'EVALUATING',
      openedAt: '2026-10-20T07:00:00.000Z',
      openedBy: 'U',
      bidCount: 2,
      alreadyOpened: true,
    };
    expect(
      await send(
        open,
        jest.fn(async () => jsonResponse(200, opened)),
      ),
    ).toMatchObject({ kind: 'CREATED' });
    // Still closed, or another tender's: not this opening.
    for (const other of [{ status: 'CLOSED' }, { tenderId: 'TND_OTHER' }]) {
      expect(
        await send(
          open,
          jest.fn(async () => jsonResponse(200, { ...opened, ...other })),
        ),
      ).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
    }
  });

  it('a proposal and its withdrawal are confirmed only for this tender', async () => {
    const propose: OwnerBinding = {
      command: 'PROPOSE_OPENING',
      approvalId: null,
      expectedVersion: null,
    };
    const withdraw: OwnerBinding = {
      command: 'WITHDRAW_PROPOSAL',
      approvalId: null,
      expectedVersion: null,
    };
    const proposed = { tenderId: TENDER_ID, proposedBy: 'U', alreadyProposed: false };
    const withdrawn = { tenderId: TENDER_ID, withdrawnProposal: 'U' };
    expect(
      await send(
        propose,
        jest.fn(async () => jsonResponse(200, proposed)),
      ),
    ).toMatchObject({
      kind: 'CREATED',
    });
    expect(
      await send(
        withdraw,
        jest.fn(async () => jsonResponse(200, withdrawn)),
      ),
    ).toMatchObject({
      kind: 'CREATED',
    });
    expect(
      await send(
        propose,
        jest.fn(async () => jsonResponse(200, { ...proposed, tenderId: 'TND_OTHER' })),
      ),
    ).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
    expect(
      await send(
        withdraw,
        jest.fn(async () => jsonResponse(200, { ...withdrawn, tenderId: 'TND_OTHER' })),
      ),
    ).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });

  it('a conflict of interest is a 403 with its closed reason', async () => {
    expect(
      await send(
        open,
        jest.fn(async () =>
          problem(403, 'FORBIDDEN', [{ path: 'opening', code: 'CONFLICT_OF_INTEREST' }]),
        ),
      ),
    ).toMatchObject({
      kind: 'FORBIDDEN',
      reasons: ['CONFLICT_OF_INTEREST'],
    });
  });

  it('an unknown refusal is one fixed sentence; a 5xx and a 504 are unconfirmed', async () => {
    expect(
      await send(
        open,
        jest.fn(async () => problem(422, 'SOMETHING_NEW')),
      ),
    ).toMatchObject({
      kind: 'INVALID',
      message: OWNER_REFUSAL_FALLBACK,
    });
    expect(
      await send(
        open,
        jest.fn(async () => problem(503, 'UPSTREAM_UNAVAILABLE')),
      ),
    ).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
    expect(
      await send(
        open,
        jest.fn(async () => problem(504, 'UPSTREAM_TIMEOUT')),
      ),
    ).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });

  it('another organization’s tender is NOT_FOUND', async () => {
    expect(
      await send(
        publish,
        jest.fn(async () => problem(404, 'NOT_FOUND')),
      ),
    ).toMatchObject({ kind: 'NOT_FOUND' });
  });
});
