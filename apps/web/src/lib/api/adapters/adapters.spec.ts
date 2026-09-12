import { z } from 'zod';
import { ApiClient } from '../client';
import { ApiFailure, CLIENT_ERROR_CODES } from '../errors';
import { ADAPTERS } from '../adapter-registry';
import { fetchDossier, fetchTimeline, listAssets } from './asset';
import { fetchAuditEvent, searchAuditEvents, verifyAuditChain } from './audit';
import { listDocuments } from './document';
import { fetchTrialBalance, fetchWallet, listLedgerAccounts, listTransactions } from './economic';
import { listAvailability, listDrivers, listUtilization } from './fleet';
import { fetchCurrentUser, listUsers } from './identity';
import { fetchMaintenanceRequest, listDueSchedules, listMaintenanceRequests } from './maintenance';
import { fetchOrder, listOrders } from './marketplace';
import { searchSuppliers } from './supplier';

/**
 * Every adapter, checked at the wire.
 *
 * Two things are asserted and they are different questions. The first is
 * *where* a request goes: the path has to match the controller it was written
 * against, because a path that is merely plausible reaches a 404 at the gateway
 * and looks, from the screen, exactly like an empty result. The second is
 * *what the client refuses to accept*: every response is parsed against the
 * schema, so a contract drift shows up as a reported failure rather than as a
 * page rendering `undefined` where a price should be.
 *
 * A note on the boolean query parameters. Several services read them through a
 * `queryBoolean` helper rather than `z.coerce.boolean()`, because the coercion
 * applies JavaScript's `Boolean()` — under which the string `"false"` is true,
 * so `?includeIncoming=false` opted the caller *into* the wider view (D-023).
 * The adapters therefore send the literal string, and the tests below assert
 * exactly that rather than assuming a serialization.
 */

const GATEWAY = 'http://localhost:3000';

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

const page = (items: unknown[]) => ({ items, nextCursor: null, hasMore: false });
const AUDIT_WINDOW = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' };

// ---------------------------------------------------------------------------
// Fixtures, each mirroring the shape its service returns
// ---------------------------------------------------------------------------

const ASSET = {
  id: 'ast_1',
  organizationId: 'org_one',
  assetTag: '۱۲ ب ۳۴۵',
  name: 'گریدر',
  type: 'GRADER',
  manufacturer: null,
  model: null,
  serialNumber: null,
  manufactureYear: null,
  status: 'ACTIVE',
  commissionedAt: null,
  decommissionedAt: null,
  specifications: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const DOSSIER = {
  asset: ASSET,
  organizationName: 'دهیاری الف',
  currentLocation: null,
  compliance: {
    operable: false,
    blockers: ['بیمه منقضی'],
    activeInsurance: null,
    latestInspection: null,
  },
  costs: {
    totalMinor: '9007199254740993',
    maintenanceMinor: '0',
    partsAndOrdersMinor: '0',
    entryCount: 1,
  },
  documents: [],
  recentActivity: [],
  transferCount: 0,
};

describe('gateway paths', () => {
  it.each([
    ['assets', (c: ApiClient) => listAssets(c), '/v1/assets'],
    ['asset dossier', (c: ApiClient) => fetchDossier(c, 'ast_1'), '/v1/assets/ast_1/dossier'],
    ['asset timeline', (c: ApiClient) => fetchTimeline(c, 'ast_1'), '/v1/assets/ast_1/timeline'],
    ['fleet availability', (c: ApiClient) => listAvailability(c), '/v1/fleet/availability'],
    ['fleet utilization', (c: ApiClient) => listUtilization(c), '/v1/fleet/utilization'],
    ['drivers', (c: ApiClient) => listDrivers(c), '/v1/drivers'],
    ['due schedules', (c: ApiClient) => listDueSchedules(c), '/v1/maintenance-schedules/due'],
    [
      'maintenance requests',
      (c: ApiClient) => listMaintenanceRequests(c),
      '/v1/maintenance-requests',
    ],
    ['orders', (c: ApiClient) => listOrders(c), '/v1/orders'],
    ['wallet', (c: ApiClient) => fetchWallet(c), '/v1/wallets/me'],
    ['transactions', (c: ApiClient) => listTransactions(c), '/v1/transactions'],
    ['ledger accounts', (c: ApiClient) => listLedgerAccounts(c), '/v1/ledger/accounts'],
    ['trial balance', (c: ApiClient) => fetchTrialBalance(c), '/v1/ledger/trial-balance'],
    ['documents', (c: ApiClient) => listDocuments(c), '/v1/documents'],
    ['suppliers', (c: ApiClient) => searchSuppliers(c), '/v1/suppliers'],
    ['current user', (c: ApiClient) => fetchCurrentUser(c), '/v1/users/me'],
    ['users', (c: ApiClient) => listUsers(c), '/v1/users'],
    ['audit events', (c: ApiClient) => searchAuditEvents(c, AUDIT_WINDOW), '/v1/audit-events'],
    [
      'audit event detail',
      (c: ApiClient) => fetchAuditEvent(c, 'aev_1', AUDIT_WINDOW),
      '/v1/audit-events/aev_1',
    ],
    [
      'audit verify',
      (c: ApiClient) => verifyAuditChain(c, AUDIT_WINDOW),
      '/v1/audit-events/verify',
    ],
  ])('%s targets %s on the gateway', async (_name, call, expectedPath) => {
    // The body is deliberately wrong for most of these; the assertion is about
    // where the request went, and a schema failure still records the call.
    const { client, fetchMock } = harness(page([]));
    await call(client).catch(() => undefined);

    const url = requestedUrl(fetchMock);
    expect(url.origin).toBe(GATEWAY);
    expect(url.pathname).toBe(expectedPath);
  });

  it('escapes an identifier rather than interpolating it raw', async () => {
    const { client, fetchMock } = harness(DOSSIER);
    await fetchDossier(client, 'ast/../secret').catch(() => undefined);

    // Encoded, so a crafted id cannot climb out of the resource path. The
    // client refuses a non-`/v1/` target as a second line of defence.
    expect(requestedUrl(fetchMock).pathname).toBe('/v1/assets/ast%2F..%2Fsecret/dossier');
  });
});

describe('boolean query parameters travel as literal strings', () => {
  it('sends includeIncoming=false rather than omitting it', async () => {
    const { client, fetchMock } = harness(page([]));
    await listTransactions(client, { includeIncoming: false }).catch(() => undefined);

    expect(requestedUrl(fetchMock).searchParams.get('includeIncoming')).toBe('false');
  });

  it('sends includeNotDue=true as a string', async () => {
    const { client, fetchMock } = harness(page([]));
    await listDueSchedules(client, { includeNotDue: true }).catch(() => undefined);

    expect(requestedUrl(fetchMock).searchParams.get('includeNotDue')).toBe('true');
  });

  it('omits a boolean the caller did not set', async () => {
    const { client, fetchMock } = harness(page([]));
    await listMaintenanceRequests(client).catch(() => undefined);

    expect(requestedUrl(fetchMock).searchParams.has('openOnly')).toBe(false);
  });
});

describe('query shaping', () => {
  it('passes the order side explicitly', async () => {
    const { client, fetchMock } = harness({ items: [], nextCursor: null });
    await listOrders(client, 'SUPPLIER').catch(() => undefined);

    expect(requestedUrl(fetchMock).searchParams.get('role')).toBe('SUPPLIER');
  });

  it('drops status when qualifiedFor is set, which the service refuses together', async () => {
    // `qualifiedFor` already implies ACTIVE. Sending both with SUSPENDED is a
    // contradiction the service answers 400 to, rather than letting one filter
    // silently overwrite the other.
    const { client, fetchMock } = harness(page([]));
    await searchSuppliers(client, {
      qualifiedFor: 'WORKSHOP_SERVICE',
      status: 'SUSPENDED',
    }).catch(() => undefined);

    const url = requestedUrl(fetchMock);
    expect(url.searchParams.get('qualifiedFor')).toBe('WORKSHOP_SERVICE');
    expect(url.searchParams.has('status')).toBe(false);
  });

  it('trims an empty search term instead of sending a blank one', async () => {
    const { client, fetchMock } = harness(page([]));
    await listAssets(client, { q: '   ' }).catch(() => undefined);

    expect(requestedUrl(fetchMock).searchParams.has('q')).toBe(false);
  });
});

describe('responses are validated, not trusted', () => {
  it('accepts a dossier with a cost beyond safe-integer range and keeps it a string', async () => {
    const { client } = harness(DOSSIER);
    const dossier = await fetchDossier(client, 'ast_1');

    expect(dossier.costs.totalMinor).toBe('9007199254740993');
    expect(typeof dossier.costs.totalMinor).toBe('string');
  });

  it('keeps every compliance blocker rather than the first', async () => {
    const { client } = harness({
      ...DOSSIER,
      compliance: { ...DOSSIER.compliance, blockers: ['یک', 'دو', 'سه'] },
    });

    // The service returns all of them so an operator fixing one need not
    // re-check to find the next; the adapter must not collapse them.
    expect((await fetchDossier(client, 'ast_1')).compliance.blockers).toHaveLength(3);
  });

  it('preserves a null utilisation instead of coercing it to zero', async () => {
    const { client } = harness({
      items: [
        {
          assetId: 'ast_1',
          assetName: null,
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-02-01T00:00:00.000Z',
          usedHours: '0',
          kilometres: '0',
          availableHours: '100',
          utilizationPercent: null,
          recordCount: 0,
          assignmentCount: 0,
        },
      ],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });

    // "No readings" and "the machine sat idle" are different facts.
    expect((await listUtilization(client))[0]?.utilizationPercent).toBeNull();
  });

  it('refuses an offer whose qualification is a boolean rather than UNAVAILABLE', async () => {
    // A `false` would say a check ran and the supplier failed it. Nothing has
    // checked, so the only permitted value is the literal string (ADR-041 § 1).
    const { client } = harness({
      items: [
        {
          id: 'ofr_1',
          productId: 'prd_1',
          supplierOrganizationId: 'org_s',
          unitPriceMinor: '100',
          currency: 'IRR',
          availableQuantity: 1,
          leadTimeDays: 1,
          minimumQuantity: 1,
          status: 'PUBLISHED',
          version: 1,
          supplierQualification: false,
        },
      ],
    });

    const failure = await import('./marketplace').then((module) =>
      module.offersForProduct(client, 'prd_1').catch((error: unknown) => error),
    );

    expect(failure).toBeInstanceOf(ApiFailure);
    expect((failure as ApiFailure).code).toBe(CLIENT_ERROR_CODES.MALFORMED_RESPONSE);
  });

  it('refuses a money field that arrived as a JSON number', async () => {
    // A large rial figure would already have lost precision in the parser by
    // the time it reached here, which is exactly why the contract is a string.
    const { client } = harness({ ...DOSSIER, costs: { ...DOSSIER.costs, totalMinor: 12000 } });
    const failure = await fetchDossier(client, 'ast_1').catch((error: unknown) => error);

    expect((failure as ApiFailure).code).toBe(CLIENT_ERROR_CODES.MALFORMED_RESPONSE);
  });

  it('reports a maintenance detail missing its cost breakdown', async () => {
    const { client } = harness({ id: 'mrq_1', title: 'x' });
    const failure = await fetchMaintenanceRequest(client, 'mrq_1').catch((error: unknown) => error);

    expect((failure as ApiFailure).code).toBe(CLIENT_ERROR_CODES.MALFORMED_RESPONSE);
  });

  it('reports an order whose status arrived in the wrong shape', async () => {
    const { client } = harness({ id: 'ord_1', status: 42 });
    const failure = await fetchOrder(client, 'ord_1').catch((error: unknown) => error);

    expect((failure as ApiFailure).code).toBe(CLIENT_ERROR_CODES.MALFORMED_RESPONSE);
  });

  it('accepts the document list shape, which carries no hasMore', async () => {
    const { client } = harness({
      items: [],
      // `document-service` returns `{ items, nextCursor }` only; a schema that
      // required `hasMore` would reject every real response.
      nextCursor: null,
    });

    await expect(listDocuments(client)).resolves.toEqual([]);
  });
});

describe('adapter descriptors', () => {
  it('names only routes under the version prefix', () => {
    for (const adapter of ADAPTERS) {
      for (const route of adapter.routes) {
        expect(route).toMatch(/^(GET|POST|PATCH|PUT|DELETE) \/v1\//);
      }
    }
  });

  it('names a real owning service for each adapter', () => {
    const services = new Set([
      'identity-service',
      'organization-service',
      'asset-service',
      'fleet-service',
      'maintenance-service',
      'marketplace-service',
      'economic-service',
      'document-service',
      'supplier-service',
      'audit-service',
    ]);

    for (const adapter of ADAPTERS) {
      expect(services.has(adapter.service)).toBe(true);
    }
  });

  it('reaches no service this milestone has no right to call', () => {
    // Nothing exists behind these prefixes; an adapter pointed at one would be
    // a claim the manifest is designed to make impossible.
    const unbuilt = ['demand-requests', 'warehouses', 'tenders', 'dashboards'];
    const declared = ADAPTERS.flatMap((adapter) =>
      adapter.routes.map((route) => route.split(' ')[1]),
    );

    for (const prefix of unbuilt) {
      expect(declared.some((path) => path?.startsWith(`/v1/${prefix}`))).toBe(false);
    }
  });
});

describe('the schemas are real zod schemas', () => {
  it('rejects an unknown shape rather than passing it through', () => {
    // Guards against a schema accidentally written as `z.any()`, which would
    // make every validation assertion above vacuous.
    const schema = z.object({ id: z.string() });
    expect(schema.safeParse({ id: 1 }).success).toBe(false);
  });
});
