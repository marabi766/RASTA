/**
 * @jest-environment node
 */
import { fetchMaintenanceRequest, fetchMaintenanceRequests } from './maintenance';
import type { WebSession } from './session';

/**
 * What the portal asks the gateway for, and what it keeps from the answer.
 *
 * Mirrors `assets.spec.ts`: the keeping is the part worth testing. A request
 * detail carries actor ids, approval notes and cancellation reasons that no
 * part of this screen renders, so none of them are declared here — and what
 * is not declared cannot survive parsing into the page.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'dehyar',
  organizationId: 'ORG_1',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
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

function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

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

const REQUEST = {
  id: 'MREQ_1',
  organizationId: 'ORG_1',
  assetId: 'AST_1',
  scheduleId: null,
  type: 'CORRECTIVE',
  status: 'OPEN',
  severity: 'HIGH',
  title: 'صدای غیرعادی موتور',
  description: 'صدای تق‌تق هنگام روشن‌شدن',
  reportedAt: '2026-02-01T08:00:00.000Z',
  reportedBy: 'USR_9',
  dueDate: '2026-02-05T00:00:00.000Z',
  outOfServiceAt: '2026-02-01T08:00:00.000Z',
  returnedToServiceAt: null,
  downtimeMinutes: null,
  startedAt: null,
  startedBy: null,
  completedAt: null,
  completedBy: null,
  approvedAt: null,
  approvedBy: null,
  approvalNotes: null,
  cancelledAt: null,
  cancelledBy: null,
  cancellationReason: null,
  totalCostMinor: '0',
  currency: 'IRR',
};

describe('the list', () => {
  it('asks the gateway, with only the filters the caller set', async () => {
    const { impl, urls } = answering({ items: [REQUEST], nextCursor: null, hasMore: false });

    await withFetch(impl, async () => {
      await fetchMaintenanceRequests(SESSION, { status: 'OPEN', severity: 'HIGH' });
    });

    const url = new URL(urls[0]!);
    expect(url.origin).toBe('http://gateway.test:3000');
    expect(url.pathname).toBe('/v1/maintenance-requests');
    expect(url.searchParams.get('status')).toBe('OPEN');
    expect(url.searchParams.get('severity')).toBe('HIGH');
    expect(url.searchParams.get('limit')).toBe('20');
    // An empty filter is a filter nobody asked for.
    expect(url.searchParams.has('type')).toBe(false);
    expect(url.searchParams.has('cursor')).toBe(false);
  });

  it('keeps the fields a row shows and drops the rest', async () => {
    const { impl } = answering({ items: [REQUEST], nextCursor: 'CUR_1', hasMore: true });

    const result = await withFetch(impl, () => fetchMaintenanceRequests(SESSION));

    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.data.items[0]).toEqual({
      id: 'MREQ_1',
      assetId: 'AST_1',
      scheduleId: null,
      type: 'CORRECTIVE',
      status: 'OPEN',
      severity: 'HIGH',
      title: 'صدای غیرعادی موتور',
      reportedAt: '2026-02-01T08:00:00.000Z',
      dueDate: '2026-02-05T00:00:00.000Z',
      totalCostMinor: '0',
    });
    expect(JSON.stringify(result.data)).not.toContain('reportedBy');
    expect(JSON.stringify(result.data)).not.toContain('USR_9');
    expect(result.data.nextCursor).toBe('CUR_1');
  });

  it('accepts a status this portal has never heard of', async () => {
    const { impl } = answering({
      items: [{ ...REQUEST, status: 'ESCALATED' }],
      nextCursor: null,
      hasMore: false,
    });

    const result = await withFetch(impl, () => fetchMaintenanceRequests(SESSION));
    expect(result.kind).toBe('OK');
    if (result.kind === 'OK') expect(result.data.items[0]!.status).toBe('ESCALATED');
  });
});

describe('how a refusal comes back', () => {
  it('separates "not yours" from "not here" from "broken"', async () => {
    const forbidden = answering({}, 403);
    expect((await withFetch(forbidden.impl, () => fetchMaintenanceRequests(SESSION))).kind).toBe(
      'FORBIDDEN',
    );

    const missing = answering({}, 404);
    expect(
      (await withFetch(missing.impl, () => fetchMaintenanceRequest(SESSION, 'MREQ_X'))).kind,
    ).toBe('NOT_FOUND');

    const broken = answering({}, 503);
    const result = await withFetch(broken.impl, () => fetchMaintenanceRequests(SESSION));
    expect(result.kind).toBe('UNAVAILABLE');
    if (result.kind === 'UNAVAILABLE') expect(result.status).toBe(503);
  });

  it('refuses an answer that does not match the contract', async () => {
    const { impl } = answering({ items: [{ id: 'MREQ_1' }], hasMore: false });
    expect((await withFetch(impl, () => fetchMaintenanceRequests(SESSION))).kind).toBe('MALFORMED');
  });
});

describe('the detail', () => {
  const DETAIL = {
    ...REQUEST,
    repairOrders: [
      {
        id: 'RO_1',
        organizationId: 'ORG_1',
        maintenanceRequestId: 'MREQ_1',
        assetId: 'AST_1',
        workshopOrganizationId: 'ORG_WORKSHOP',
        workshopName: 'تعمیرگاه مرکزی',
        status: 'IN_PROGRESS',
        workSummary: 'بررسی موتور',
        workPerformed: null,
        assignedAt: '2026-02-02T00:00:00.000Z',
        assignedBy: 'USR_2',
        startedAt: '2026-02-03T00:00:00.000Z',
        completedAt: null,
        cancelledAt: null,
        cancellationReason: null,
        partsCostMinor: '500000',
        labourCostMinor: '200000',
        otherCostMinor: '0',
        totalCostMinor: '700000',
        currency: 'IRR',
      },
    ],
    costBreakdown: [
      { category: 'PART', amountMinor: '500000', currency: 'IRR' },
      { category: 'LABOUR', amountMinor: '200000', currency: 'IRR' },
    ],
  };

  it('encodes the id into the path rather than interpolating it', async () => {
    const { impl, urls } = answering(DETAIL);
    await withFetch(impl, () => fetchMaintenanceRequest(SESSION, 'MREQ/../secret'));
    expect(new URL(urls[0]!).pathname).toBe('/v1/maintenance-requests/MREQ%2F..%2Fsecret');
  });

  it('keeps the repair order and its cost, dropping the assignee', async () => {
    const { impl } = answering(DETAIL);
    const result = await withFetch(impl, () => fetchMaintenanceRequest(SESSION, 'MREQ_1'));
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;

    expect(result.data.repairOrders[0]!.workshopName).toBe('تعمیرگاه مرکزی');
    expect(result.data.repairOrders[0]!.totalCostMinor).toBe('700000');
    expect(JSON.stringify(result.data)).not.toContain('assignedBy');
    expect(JSON.stringify(result.data)).not.toContain('workshopOrganizationId');
  });

  it('keeps every cost breakdown line, not only the first', async () => {
    const { impl } = answering(DETAIL);
    const result = await withFetch(impl, () => fetchMaintenanceRequest(SESSION, 'MREQ_1'));
    if (result.kind !== 'OK') throw new Error('expected a detail');
    expect(result.data.costBreakdown).toHaveLength(2);
  });

  it('keeps money as a string', async () => {
    // A rial amount does not survive a JSON number (ADR-022).
    const { impl } = answering(DETAIL);
    const result = await withFetch(impl, () => fetchMaintenanceRequest(SESSION, 'MREQ_1'));
    if (result.kind !== 'OK') throw new Error('expected a detail');
    expect(typeof result.data.totalCostMinor).toBe('string');
    expect(typeof result.data.repairOrders[0]!.totalCostMinor).toBe('string');
    expect(typeof result.data.costBreakdown[0]!.amountMinor).toBe('string');
  });
});
