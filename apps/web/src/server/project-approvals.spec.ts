/**
 * @jest-environment node
 */
import {
  fetchApprovalInbox,
  INBOX_MAX_PAGES,
  fetchExecutionPolicy,
  fetchProject,
  fetchProjectApprovals,
} from './projects';
import type { WebSession } from './session';
import { actingAccessToken } from '@/test/session-token';

/**
 * Reading what the project write screens are drawn from: the version a command
 * is sent at, the approval rounds, the authority's inbox, and whether the system
 * is closed for want of a policy. The case that would be silent if wrong: "could
 * not read the policy" shown as "there is none".
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'owner',
  organizationId: 'ORG_OWNER',
  accessToken: actingAccessToken('ORG_OWNER'),
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
};

beforeEach(() => {
  Object.assign(process.env, {
    API_GATEWAY_URL: 'http://gateway.test:3000',
    OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
    OIDC_CLIENT_ID: 'rasta-web',
    WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
    WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  });
});

function answering(body: unknown, status = 200) {
  const urls: string[] = [];
  const impl = (async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, urls };
}

function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const STEP = {
  id: 'APR_1',
  projectId: 'PRJ_1',
  tenderId: null,
  request: null,
  projectOrganizationId: 'ORG_OWNER',
  workflowKey: 'project.execution',
  round: 1,
  stepOrder: 1,
  policyId: 'POL_1',
  policyVersion: 1,
  approvalType: 'تایید فنی',
  authorityOrganizationId: 'ORG_COUNCIL',
  authorityRole: 'UNION_ADMIN',
  authorityLabel: 'شورای شهر',
  status: 'PENDING',
  requestedAt: '2026-10-20T08:00:00.000Z',
  decidedAt: null,
  decidedBy: null,
  decisionNumber: null,
  conditions: null,
  reason: null,
  supersededAt: null,
  version: 2,
  project: {
    title: 'پل',
    operationType: 'خاکبرداری',
    estimatedCostMinor: '1500000',
    status: 'PENDING_APPROVAL',
  },
};

const POLICY = (over: Record<string, unknown> = {}) => ({
  id: 'POL_1',
  organizationId: 'ORG_OWNER',
  authorOrganizationId: 'ORG_UNION',
  authorRole: 'UNION_ADMIN',
  workflowKey: 'project.execution',
  policyVersion: 1,
  status: 'ACTIVE',
  label: 'سیاست شورا',
  rationale: 'RATIONALE_SECRET',
  isSample: false,
  steps: [
    {
      stepOrder: 2,
      approvalType: 'تایید مالی',
      authorityOrganizationId: 'O2',
      authorityRole: 'UNION_ADMIN',
      authorityLabel: 'استانداری',
      minAmountMinor: null,
      maxAmountMinor: null,
    },
    {
      stepOrder: 1,
      approvalType: 'تایید فنی',
      authorityOrganizationId: 'O1',
      authorityRole: 'UNION_ADMIN',
      authorityLabel: 'شورای شهر',
      minAmountMinor: null,
      maxAmountMinor: null,
    },
  ],
  createdBy: 'USR_SECRET',
  version: 3,
  ...over,
});

describe('the project version', () => {
  const PROJECT = {
    id: 'PRJ_1',
    title: 'پل',
    operationType: 'خاکبرداری',
    locationDescription: 'محل',
    estimatedCostMinor: null,
    status: 'DRAFT',
    statusChangedAt: '2026-09-20T08:00:00.000Z',
    createdAt: '2026-09-19T08:00:00.000Z',
    scopeOfWork: 'شرح',
    hasArea: false,
    needsSummary: null,
  };

  it('is read for the commands to carry', async () => {
    const { impl } = answering({ ...PROJECT, version: 7 });
    const result = await withFetch(impl, () => fetchProject(SESSION, 'PRJ_1'));
    expect(result).toMatchObject({ kind: 'OK', data: { version: 7 } });
  });

  it('is absent, not guessed, when the service sent none — and a zero is malformed', async () => {
    const without = await withFetch(answering(PROJECT).impl, () => fetchProject(SESSION, 'PRJ_1'));
    expect(without).toMatchObject({ kind: 'OK' });
    expect((without as { data: { version?: number } }).data.version).toBeUndefined();
    const zero = await withFetch(answering({ ...PROJECT, version: 0 }).impl, () =>
      fetchProject(SESSION, 'PRJ_1'),
    );
    expect(zero.kind).toBe('MALFORMED');
  });
});

describe('the approvals of a project', () => {
  it('reads the array the service answers, from the encoded path, and keeps no actor id', async () => {
    const { impl, urls } = answering([STEP]);
    const result = await withFetch(impl, () => fetchProjectApprovals(SESSION, 'PRJ/1'));
    expect(urls).toEqual(['http://gateway.test:3000/v1/projects/PRJ%2F1/approvals']);
    expect(result).toMatchObject({
      kind: 'OK',
      data: [{ id: 'APR_1', version: 2, status: 'PENDING' }],
    });
    expect(JSON.stringify(result)).not.toContain('decidedBy');
    expect(JSON.stringify(result)).not.toContain('policyId');
  });

  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [503, 'UNAVAILABLE'],
  ])('tells a %i', async (status, kind) => {
    const { impl } = answering({ code: 'X', message: 'x' }, status);
    expect((await withFetch(impl, () => fetchProjectApprovals(SESSION, 'PRJ_1'))).kind).toBe(kind);
  });

  it('treats a step without a version as malformed: nothing could be decided on it', async () => {
    const without = Object.fromEntries(Object.entries(STEP).filter(([key]) => key !== 'version'));
    const { impl } = answering([without]);
    expect((await withFetch(impl, () => fetchProjectApprovals(SESSION, 'PRJ_1'))).kind).toBe(
      'MALFORMED',
    );
  });
});

describe('the authority’s inbox', () => {
  it('asks for the pending steps and keeps the project workflows only', async () => {
    const { impl, urls } = answering({
      items: [
        STEP,
        { ...STEP, id: 'APR_2', workflowKey: 'project.completion' },
        { ...STEP, id: 'APR_3', workflowKey: 'tender.award', tenderId: 'TND_1' },
        { ...STEP, id: 'APR_4', workflowKey: 'tender.publication', tenderId: 'TND_2' },
      ],
      nextCursor: null,
      hasMore: false,
    });
    const result = await withFetch(impl, () => fetchApprovalInbox(SESSION));
    expect(urls).toEqual(['http://gateway.test:3000/v1/approvals?status=PENDING&limit=50']);
    expect(result.kind).toBe('OK');
    expect((result as { data: { items: { id: string }[] } }).data.items.map((i) => i.id)).toEqual([
      'APR_1',
      'APR_2',
    ]);
  });

  function pages(bodies: unknown[]) {
    const urls: string[] = [];
    const impl = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      const body = bodies[Math.min(urls.length - 1, bodies.length - 1)];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { impl, urls };
  }
  const TENDER = (id: string) => ({ ...STEP, id, workflowKey: 'tender.award', tenderId: 'TND_1' });
  const ids = (r: unknown): string[] =>
    (r as { data: { items: { id: string }[] } }).data.items.map((i) => i.id);

  it('follows the cursor past a page of tender steps to the project step on page 2', async () => {
    const { impl, urls } = pages([
      { items: [TENDER('T1'), TENDER('T2')], nextCursor: 'CUR_2', hasMore: true },
      { items: [TENDER('T3'), STEP], nextCursor: null, hasMore: false },
    ]);
    const result = await withFetch(impl, () => fetchApprovalInbox(SESSION));
    expect(urls).toEqual([
      'http://gateway.test:3000/v1/approvals?status=PENDING&limit=50',
      'http://gateway.test:3000/v1/approvals?status=PENDING&limit=50&cursor=CUR_2',
    ]);
    expect(ids(result)).toEqual(['APR_1']);
    expect((result as { data: { hasMore: boolean } }).data.hasMore).toBe(false);
  });

  it('stops after the page limit and says more may exist, not that the inbox is empty', async () => {
    const { impl, urls } = pages([{ items: [TENDER('T1')], nextCursor: 'CUR_N', hasMore: true }]);
    const result = await withFetch(impl, () => fetchApprovalInbox(SESSION));
    expect(urls).toHaveLength(INBOX_MAX_PAGES);
    expect(ids(result)).toEqual([]);
    expect((result as { data: { hasMore: boolean } }).data.hasMore).toBe(true);
  });

  it('is unavailable, not empty, when a later page cannot be read and no project step was found', async () => {
    let call = 0;
    const impl = (async () => {
      call += 1;
      return call === 1
        ? new Response(
            JSON.stringify({ items: [TENDER('T1')], nextCursor: 'CUR_2', hasMore: true }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        : new Response(JSON.stringify({ code: 'X', message: 'x' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
    }) as typeof fetch;
    const result = await withFetch(impl, () => fetchApprovalInbox(SESSION));
    expect(result.kind).toBe('UNAVAILABLE');
  });

  it.each([
    [403, 'FORBIDDEN'],
    [503, 'UNAVAILABLE'],
  ])('tells a %i', async (status, kind) => {
    const { impl } = answering({ code: 'X', message: 'x' }, status);
    expect((await withFetch(impl, () => fetchApprovalInbox(SESSION))).kind).toBe(kind);
  });
});

describe('the execution policy', () => {
  const read = (body: unknown, status = 200, session = SESSION) => {
    const { impl, urls } = answering(body, status);
    return withFetch(impl, async () => ({ result: await fetchExecutionPolicy(session), urls }));
  };

  it('is open when an active project.execution policy governs the organization — with its steps in order, and not its rationale', async () => {
    const { result, urls } = await read({ items: [POLICY()], nextCursor: null, hasMore: false });
    expect(urls).toEqual([
      'http://gateway.test:3000/v1/approval-policies?workflowKey=project.execution&status=ACTIVE&limit=100',
    ]);
    expect(result).toEqual({
      kind: 'OK',
      data: {
        kind: 'OPEN',
        label: 'سیاست شورا',
        isSample: false,
        steps: [
          { approvalType: 'تایید فنی', authorityLabel: 'شورای شهر' },
          { approvalType: 'تایید مالی', authorityLabel: 'استانداری' },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('RATIONALE_SECRET');
  });

  it('is closed when the policies were read and none governs this organization', async () => {
    const { result } = await read({ items: [], nextCursor: null, hasMore: false });
    expect(result).toEqual({ kind: 'OK', data: { kind: 'CLOSED' } });
  });

  it('is closed when the only active policy is one written for another organization', async () => {
    const { result } = await read({
      items: [POLICY({ organizationId: 'ORG_OTHER' })],
      nextCursor: null,
      hasMore: false,
    });
    expect(result).toEqual({ kind: 'OK', data: { kind: 'CLOSED' } });
  });

  it('is not closed on a list cut short before any of this organization’s policies appeared', async () => {
    const { result } = await read({
      items: [POLICY({ organizationId: 'ORG_OTHER' })],
      nextCursor: 'c',
      hasMore: true,
    });
    expect(result).toEqual({ kind: 'OK', data: { kind: 'UNKNOWN' } });
  });

  it('ignores a policy that is not active, whatever the service sent', async () => {
    const { result } = await read({
      items: [POLICY({ status: 'RETIRED' })],
      nextCursor: null,
      hasMore: false,
    });
    expect(result).toEqual({ kind: 'OK', data: { kind: 'CLOSED' } });
  });

  it.each([
    [403, 'FORBIDDEN'],
    [503, 'UNAVAILABLE'],
    [500, 'UNAVAILABLE'],
  ])('is not closed when the read answered %i', async (status, kind) => {
    const { result } = await read({ code: 'X', message: 'x' }, status);
    expect(result.kind).toBe(kind);
  });

  it('is not closed on a body it cannot read', async () => {
    const { result } = await read({ items: 'nope' });
    expect(result.kind).toBe('MALFORMED');
  });

  it('reads nothing for a session with no organization', async () => {
    const { result, urls } = await read({ items: [] }, 200, {
      ...SESSION,
      organizationId: null,
      accessToken: actingAccessToken(null),
    });
    expect(result.kind).toBe('NOT_FOUND');
    expect(urls).toEqual([]);
  });
});
