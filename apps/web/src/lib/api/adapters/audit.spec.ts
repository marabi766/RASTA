import { ApiClient } from '../client';
import { ApiFailure, CLIENT_ERROR_CODES } from '../errors';
import { AUDIT_ADAPTER, fetchAuditEvent, searchAuditEvents, verifyAuditChain } from './audit';

const GATEWAY = 'http://localhost:3000';
const WINDOW = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' };

function harness(body: unknown, status = 200) {
  const fetchMock = jest.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );

  const client = new ApiClient({
    baseUrl: GATEWAY,
    fetchImpl: fetchMock as unknown as typeof fetch,
    newCorrelationId: () => 'cid-test',
    session: () => ({
      accessToken: 'token',
      organizationId: 'org_one',
      organizationIds: ['org_one'],
    }),
  });

  return { client, fetchMock };
}

function requestedUrl(fetchMock: jest.Mock): URL {
  return new URL((fetchMock.mock.calls[0] as [string])[0]);
}

const EVENT = {
  id: 'aev_1',
  occurredAt: '2026-01-01T10:00:00.000Z',
  recordedAt: '2026-01-01T10:00:01.000Z',
  actorType: 'USER',
  actorId: 'usr_1',
  actorRoles: [],
  organizationId: 'org_one',
  action: 'asset.asset_registered',
  resourceType: 'Asset',
  resourceId: 'ast_1',
  outcome: 'SUCCESS',
  errorCode: null,
  reason: null,
  changes: null,
  occurrenceCount: 1,
  sourceService: 'asset-service',
  sourceServiceVersion: '1.0.0',
  sourceEventId: 'evt_1',
  sourceEventName: 'ASSET_REGISTERED',
  sourceTopic: 'rasta.asset.v1',
  sourceIp: null,
  sourceUserAgent: null,
  correlationId: 'cid_1',
  causationId: null,
  traceparent: null,
  sourceStreamSeq: '1',
  sequenceNo: '1',
  integrity: 'CHAINED',
};

const PAGE = { items: [EVENT], nextCursor: 'opaque-cursor-value', hasMore: true };

const VERIFICATION = {
  scope: 'ORGANIZATION',
  organizationId: 'org_one',
  from: WINDOW.from,
  to: WINDOW.to,
  status: 'VALID',
  valid: true,
  canonicalVersion: 1,
  recordsInRange: 1,
  recordsVerified: 1,
  unchainedRecords: 0,
  months: [
    {
      month: '2026-01',
      status: 'VALID',
      recordsInRange: 1,
      recordsVerified: 1,
      unchainedRecords: 0,
      seededFromPredecessor: true,
    },
  ],
  firstDivergence: null,
};

describe('audit adapter: no write method exists', () => {
  it('declares only GET routes', () => {
    for (const route of AUDIT_ADAPTER.routes) {
      expect(route.startsWith('GET ')).toBe(true);
    }
  });

  it('exposes no function that sends anything but a GET', async () => {
    const { client, fetchMock } = harness(PAGE);
    await searchAuditEvents(client, WINDOW).catch(() => undefined);
    await fetchAuditEvent(client, 'aev_1', WINDOW).catch(() => undefined);
    await verifyAuditChain(client, WINDOW).catch(() => undefined);

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.method ?? 'GET').toBe('GET');
    }
  });
});

describe('audit adapter: gateway paths', () => {
  it('sends the mandatory window on a search', async () => {
    const { client, fetchMock } = harness(PAGE);
    await searchAuditEvents(client, WINDOW);

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe('/v1/audit-events');
    expect(url.searchParams.get('from')).toBe(WINDOW.from);
    expect(url.searchParams.get('to')).toBe(WINDOW.to);
  });

  it('never decodes the cursor — it travels exactly as received', async () => {
    const { client, fetchMock } = harness(PAGE);
    await searchAuditEvents(client, WINDOW, { cursor: 'opaque-cursor-value' });

    expect(requestedUrl(fetchMock).searchParams.get('cursor')).toBe('opaque-cursor-value');
  });

  it('echoes the page’s own next cursor back unmodified, not a derived value', async () => {
    const { client } = harness(PAGE);
    const page = await searchAuditEvents(client, WINDOW);

    expect(page.nextCursor).toBe('opaque-cursor-value');
    expect(page.hasMore).toBe(true);
  });

  it('escapes an identifier in the detail path', async () => {
    const { client, fetchMock } = harness(EVENT);
    await fetchAuditEvent(client, 'aev/../secret', WINDOW).catch(() => undefined);

    expect(requestedUrl(fetchMock).pathname).toBe('/v1/audit-events/aev%2F..%2Fsecret');
  });

  it('targets verify at its own path, not the detail path', async () => {
    const { client, fetchMock } = harness(VERIFICATION);
    await verifyAuditChain(client, WINDOW);

    expect(requestedUrl(fetchMock).pathname).toBe('/v1/audit-events/verify');
  });

  it('refuses organizationId together with scope=PLATFORM at the type level only — sends it through as asked', async () => {
    // The adapter does not duplicate the service's own refusal; it sends
    // whatever the caller passed and lets the service's 400 come back through
    // the normal error path, same as every other adapter in this directory.
    const { client, fetchMock } = harness(VERIFICATION);
    await verifyAuditChain(client, WINDOW, { scope: 'PLATFORM' });

    const url = requestedUrl(fetchMock);
    expect(url.searchParams.get('scope')).toBe('PLATFORM');
    expect(url.searchParams.has('organizationId')).toBe(false);
  });
});

describe('audit adapter: responses are validated, not trusted', () => {
  it('refuses a page whose item is missing required fields', async () => {
    const { client } = harness({ items: [{ id: 'aev_1' }], nextCursor: null, hasMore: false });
    const failure = await searchAuditEvents(client, WINDOW).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiFailure);
    expect((failure as ApiFailure).code).toBe(CLIENT_ERROR_CODES.MALFORMED_RESPONSE);
  });

  it('refuses a sequence number that arrived as a JSON number rather than a string', async () => {
    const { client } = harness({ ...EVENT, sequenceNo: 1 });
    const failure = await fetchAuditEvent(client, 'aev_1', WINDOW).catch((error: unknown) => error);

    expect((failure as ApiFailure).code).toBe(CLIENT_ERROR_CODES.MALFORMED_RESPONSE);
  });

  it('accepts the four documented verification statuses', async () => {
    for (const status of ['VALID', 'EMPTY', 'UNVERIFIABLE_LEGACY', 'DIVERGENT']) {
      const { client } = harness({
        ...VERIFICATION,
        status,
        valid: status === 'VALID',
        firstDivergence:
          status === 'DIVERGENT'
            ? {
                month: '2026-01',
                auditEventId: 'aev_1',
                occurredAt: WINDOW.from,
                sequenceNo: '1',
                reason: 'RECORD_HASH_MISMATCH',
              }
            : null,
      });

      await expect(verifyAuditChain(client, WINDOW)).resolves.toMatchObject({ status });
    }
  });
});
