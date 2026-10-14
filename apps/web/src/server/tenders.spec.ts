/**
 * @jest-environment node
 */
import {
  fetchOpenTender,
  fetchOpenTenders,
  fetchTender,
  fetchTenderCriteria,
  fetchTenders,
} from './tenders';
import type { WebSession } from './session';

/**
 * Reading tenders. The cases that would be silent if wrong: an actor id, the
 * owner's organization or anything bid-shaped reaching the page, a timestamp the
 * formatter would throw on, the wrong gateway door, and a 404 (a tender the
 * caller may not see) told apart from a missing one.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'owner',
  organizationId: 'ORG_OWNER',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
};

const ENV = {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
};

beforeEach(() => {
  Object.assign(process.env, ENV);
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

const TENDER = {
  id: 'TND_1',
  organizationId: 'ORG_OWNER',
  projectId: 'PRJ_1',
  title: 'زیرسازی جادهٔ دسترسی',
  scopeOfWork: 'خاکبرداری و تسطیح',
  procurementNature: 'FORMAL_TENDER',
  visibility: 'PUBLIC',
  bidOpeningAt: '2026-10-20T08:00:00.000Z',
  bidClosingAt: '2026-10-30T08:00:00.000Z',
  status: 'PUBLISHED',
  statusReason: null,
  statusReasonCode: null,
  statusChangedAt: '2026-10-19T08:00:00.000Z',
  statusChangedBy: 'USR_ACTOR_SECRET',
  publishedAt: '2026-10-19T08:00:00.000Z',
  publishedBy: 'USR_ACTOR_SECRET',
  createdAt: '2026-10-18T08:00:00.000Z',
  createdBy: 'USR_ACTOR_SECRET',
  updatedAt: '2026-10-19T08:00:00.000Z',
  updatedBy: 'USR_ACTOR_SECRET',
  version: 3,
};

const CRITERION = {
  code: 'PRICE',
  label: 'قیمت',
  weightBp: 6000,
  scoringMethod: 'MANUAL_SCORE',
  maxScore: 100,
};

const OPEN_TENDER = {
  id: 'TND_1',
  title: TENDER.title,
  scopeOfWork: TENDER.scopeOfWork,
  procurementNature: 'FORMAL_TENDER',
  visibility: 'PUBLIC',
  bidOpeningAt: TENDER.bidOpeningAt,
  bidClosingAt: TENDER.bidClosingAt,
  criteria: [CRITERION],
};

describe('the owner’s side', () => {
  it('reads the list from /v1/tenders with a page size and only the filters that were set', async () => {
    const { impl, urls } = answering({ items: [TENDER], nextCursor: 'c2', hasMore: true });
    const result = await withFetch(impl, () =>
      fetchTenders(SESSION, { status: 'PUBLISHED', cursor: 'c1' }),
    );

    expect(urls[0]).toBe('http://gateway.test:3000/v1/tenders?limit=20&status=PUBLISHED&cursor=c1');
    expect(result.kind === 'OK' && result.data.nextCursor).toBe('c2');

    const bare = answering({ items: [], nextCursor: null, hasMore: false });
    await withFetch(bare.impl, () => fetchTenders(SESSION));
    expect(bare.urls[0]).toBe('http://gateway.test:3000/v1/tenders?limit=20');
  });

  it('never lets an actor id, the owner organization or the version into what the screen receives', async () => {
    const { impl } = answering(TENDER);
    const result = await withFetch(impl, () => fetchTender(SESSION, 'TND_1'));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('USR_ACTOR_SECRET');
    expect(serialized).not.toContain('ORG_OWNER');
    expect(serialized).not.toContain('version');
    expect(result.kind === 'OK' && result.data.projectId).toBe('PRJ_1');
  });

  it('keeps the scope prose out of the list, which the screen does not render', async () => {
    const { impl } = answering({ items: [TENDER] });
    const result = await withFetch(impl, () => fetchTenders(SESSION));
    expect(JSON.stringify(result)).not.toContain('scopeOfWork');
  });

  it('reads the criteria from the owner’s criteria route and encodes the id into the path', async () => {
    const { impl, urls } = answering({
      tenderId: 'x',
      items: [{ ...CRITERION, id: 'CRT_1', position: 1, templateId: 'TPL_SECRET' }],
      totalWeightBp: 6000,
      complete: false,
      version: 3,
    });
    const result = await withFetch(impl, () => fetchTenderCriteria(SESSION, '../x?y'));

    expect(urls[0]).toBe('http://gateway.test:3000/v1/tenders/..%2Fx%3Fy/criteria');
    expect(result.kind === 'OK' && result.data.items[0]?.label).toBe('قیمت');
    expect(JSON.stringify(result)).not.toContain('TPL_SECRET');
  });

  it('never asks for a bid, an evaluation, an award or an invitation', async () => {
    const all = answering(TENDER);
    await withFetch(all.impl, async () => {
      await fetchTenders(SESSION);
      await fetchTender(SESSION, 'TND_1');
      await fetchTenderCriteria(SESSION, 'TND_1');
      await fetchOpenTenders(SESSION);
      await fetchOpenTender(SESSION, 'TND_1');
    });

    for (const url of all.urls) {
      expect(url).not.toMatch(/\/(bids|bid-access-log|evaluation|award|invitations|approvals)/);
    }
  });
});

describe('the bidder’s side', () => {
  it('reads the list and the detail from /v1/open-tenders', async () => {
    const list = answering({ items: [OPEN_TENDER], nextCursor: null, hasMore: false });
    await withFetch(list.impl, () => fetchOpenTenders(SESSION, { cursor: 'c1' }));
    expect(list.urls[0]).toBe('http://gateway.test:3000/v1/open-tenders?limit=20&cursor=c1');

    const detail = answering(OPEN_TENDER);
    const result = await withFetch(detail.impl, () => fetchOpenTender(SESSION, 'TND_1'));
    expect(detail.urls[0]).toBe('http://gateway.test:3000/v1/open-tenders/TND_1');
    expect(result.kind === 'OK' && result.data.criteria).toHaveLength(1);
  });

  it('does not carry the scope or the criteria into a list row', async () => {
    const { impl } = answering({ items: [OPEN_TENDER] });
    const result = await withFetch(impl, () => fetchOpenTenders(SESSION));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('scopeOfWork');
    expect(serialized).not.toContain('criteria');
  });

  it('refuses a published tender without a window rather than showing it open-ended', async () => {
    const { impl } = answering({ ...OPEN_TENDER, bidOpeningAt: '', bidClosingAt: '' });
    const result = await withFetch(impl, () => fetchOpenTender(SESSION, 'TND_1'));
    expect(result.kind).toBe('MALFORMED');
  });
});

describe('outcomes', () => {
  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [503, 'UNAVAILABLE'],
  ])('maps a %i from the service to %s on every read', async (status, kind) => {
    const reads: ((session: WebSession) => Promise<{ kind: string }>)[] = [
      (s: WebSession) => fetchTenders(s),
      (s: WebSession) => fetchTender(s, 'TND_1'),
      (s: WebSession) => fetchTenderCriteria(s, 'TND_1'),
      (s: WebSession) => fetchOpenTenders(s),
      (s: WebSession) => fetchOpenTender(s, 'TND_1'),
    ];
    for (const read of reads) {
      const { impl } = answering(
        { code: 'X', message: 'raw service text', correlationId: 'c' },
        status,
      );
      const result = await withFetch(impl, () => read(SESSION));
      expect(result.kind).toBe(kind);
      // No raw service text is carried into the result.
      expect(JSON.stringify(result)).not.toContain('raw service text');
    }
  });

  it('treats a body that does not match the schema as malformed', async () => {
    const { impl } = answering({ items: 'nope' });
    expect((await withFetch(impl, () => fetchTenders(SESSION))).kind).toBe('MALFORMED');
    expect((await withFetch(impl, () => fetchOpenTenders(SESSION))).kind).toBe('MALFORMED');
  });
});

describe('timestamps', () => {
  const BAD_INSTANTS = ['UPSTREAM_INVALID_TIMESTAMP', '', '2026-10-20', '2026-10-20T08:00:00'];

  it.each(BAD_INSTANTS)('refuses %j in the owner list and detail', async (bad) => {
    for (const field of ['statusChangedAt', 'bidOpeningAt', 'bidClosingAt'] as const) {
      const { impl } = answering({ items: [{ ...TENDER, [field]: bad }] });
      const list = await withFetch(impl, () => fetchTenders(SESSION));
      expect(list.kind).toBe('MALFORMED');
      expect(JSON.stringify(list)).not.toContain('UPSTREAM_INVALID');
    }
  });

  it.each(['statusChangedAt', 'createdAt', 'publishedAt', 'bidOpeningAt'] as const)(
    'refuses a malformed %s on the owner detail',
    async (field) => {
      const { impl } = answering({ ...TENDER, [field]: 'UPSTREAM_INVALID_TIMESTAMP' });
      expect((await withFetch(impl, () => fetchTender(SESSION, 'TND_1'))).kind).toBe('MALFORMED');
    },
  );

  it('accepts an absent window and publication on the owner side, as a DRAFT has none', async () => {
    const { impl } = answering({
      ...TENDER,
      status: 'DRAFT',
      bidOpeningAt: null,
      bidClosingAt: null,
      publishedAt: null,
    });
    const result = await withFetch(impl, () => fetchTender(SESSION, 'TND_1'));
    expect(result.kind).toBe('OK');
  });

  it.each(['bidOpeningAt', 'bidClosingAt'] as const)(
    'refuses a malformed %s on the bidder side, list and detail',
    async (field) => {
      const bad = { ...OPEN_TENDER, [field]: 'UPSTREAM_INVALID_TIMESTAMP' };
      const list = answering({ items: [bad] });
      expect((await withFetch(list.impl, () => fetchOpenTenders(SESSION))).kind).toBe('MALFORMED');
      const detail = answering(bad);
      expect((await withFetch(detail.impl, () => fetchOpenTender(SESSION, 'TND_1'))).kind).toBe(
        'MALFORMED',
      );
    },
  );

  it('does not read a field the list never renders', async () => {
    const { impl } = answering({
      items: [{ ...TENDER, updatedAt: 'not a date', createdAt: 'x', publishedAt: 'x' }],
    });
    const result = await withFetch(impl, () => fetchTenders(SESSION));
    expect(result.kind).toBe('OK');
    expect(JSON.stringify(result)).not.toContain('updatedAt');
  });
});
