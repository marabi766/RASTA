/**
 * @jest-environment node
 */
import { fetchProject, fetchProjects } from './projects';
import type { WebSession } from './session';

/**
 * Reading projects. The cases that would be silent if wrong: an estimate
 * coerced to a `number`, the polygon or an actor id reaching the page, and a
 * 404 (another tenant's project) told apart from a missing one.
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

/** Past 2^53: a `number` could not hold it, and would not say so. */
const HUGE = '90071992547409931234';

const PROJECT = {
  id: 'PRJ_1',
  organizationId: 'ORG_OWNER',
  title: 'زیرسازی جادهٔ دسترسی',
  operationType: 'خاکبرداری',
  locationDescription: 'کیلومتر ۱۲ محور شمالی',
  hasArea: true,
  estimatedCostMinor: HUGE,
  status: 'APPROVED',
  statusReason: null,
  statusChangedAt: '2026-09-20T08:00:00.000Z',
  statusChangedBy: 'USR_ACTOR_SECRET',
  createdAt: '2026-09-19T08:00:00.000Z',
  createdBy: 'USR_ACTOR_SECRET',
  updatedAt: '2026-09-20T08:00:00.000Z',
  updatedBy: 'USR_ACTOR_SECRET',
  version: 4,
  scopeOfWork: 'خاکبرداری و تسطیح',
  area: { type: 'Polygon', coordinates: [[[51, 35]]] },
  needsSummary: { draft: 1, submitted: 2, withdrawn: 0 },
};

describe('reading projects', () => {
  it('keeps an estimate past 2^53 exactly, as the string it arrived as', async () => {
    const { impl } = answering(PROJECT);
    const result = await withFetch(impl, () => fetchProject(SESSION, 'PRJ_1'));

    expect(result.kind === 'OK' && result.data.estimatedCostMinor).toBe(HUGE);
  });

  it('refuses an estimate that is not whole minor units, rather than rendering it', async () => {
    const { impl } = answering({ ...PROJECT, estimatedCostMinor: '12.5' });
    const result = await withFetch(impl, () => fetchProject(SESSION, 'PRJ_1'));
    expect(result.kind).toBe('MALFORMED');
  });

  it('never lets the polygon or an actor id into what the screen receives', async () => {
    const { impl } = answering(PROJECT);
    const result = await withFetch(impl, () => fetchProject(SESSION, 'PRJ_1'));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('USR_ACTOR_SECRET');
    expect(serialized).not.toContain('coordinates');
    expect(result.kind === 'OK' && result.data.hasArea).toBe(true);
  });

  it('reads the list with a page size and the filters that were set, and only those', async () => {
    const { impl, urls } = answering({ items: [PROJECT], nextCursor: 'c2', hasMore: true });
    const result = await withFetch(impl, () =>
      fetchProjects(SESSION, { status: 'IN_PROGRESS', cursor: 'c1' }),
    );

    expect(urls[0]).toBe(
      'http://gateway.test:3000/v1/projects?limit=20&status=IN_PROGRESS&cursor=c1',
    );
    expect(result.kind === 'OK' && result.data.nextCursor).toBe('c2');

    const bare = answering({ items: [], nextCursor: null, hasMore: false });
    await withFetch(bare.impl, () => fetchProjects(SESSION));
    expect(bare.urls[0]).toBe('http://gateway.test:3000/v1/projects?limit=20');
  });

  it('encodes the id into the path', async () => {
    const { impl, urls } = answering(PROJECT);
    await withFetch(impl, () => fetchProject(SESSION, '../x?y'));
    expect(urls[0]).toBe('http://gateway.test:3000/v1/projects/..%2Fx%3Fy');
  });

  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [503, 'UNAVAILABLE'],
  ])('maps a %i from the service to %s', async (status, kind) => {
    const { impl } = answering(
      { code: 'X', message: 'raw service text', correlationId: 'c' },
      status,
    );
    const result = await withFetch(impl, () => fetchProject(SESSION, 'PRJ_1'));
    expect(result.kind).toBe(kind);
    // No raw service text is carried into the result.
    expect(JSON.stringify(result)).not.toContain('raw service text');
  });

  it('treats a body that does not match the schema as malformed', async () => {
    const { impl } = answering({ items: 'nope' });
    const result = await withFetch(impl, () => fetchProjects(SESSION));
    expect(result.kind).toBe('MALFORMED');
  });
});
