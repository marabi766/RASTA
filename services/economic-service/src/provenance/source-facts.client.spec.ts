import { InternalTokenService, RastaError } from '@rasta/nest-common';
import { SourceFactsClient } from './source-facts.client';

/**
 * The HTTP half of asking an owner (ADR-061 § 4): which token, which URL, and
 * the three answers (a fact, "no such record", or "could not ask"), against a
 * fake `fetch`.
 */
describe('SourceFactsClient', () => {
  const SECRET = 'a_unit_test_secret_that_is_at_least_32_chars';
  const ISSUER = 'rasta-internal';
  const tokens = new InternalTokenService(SECRET, ISSUER, 60);

  const approval = {
    id: 'MNT_1',
    organizationId: 'ORG-A',
    assetId: 'AST_1',
    type: 'CORRECTIVE',
    scheduleId: null,
    status: 'APPROVED',
    completedAt: '2026-09-25T09:00:00.000Z',
    completedBy: 'USR-MECHANIC',
    downtimeMinutes: 120,
    approvedAt: '2026-09-25T10:00:00.000Z',
    approvedBy: 'USR-APPROVER',
    totalCostMinor: '450000',
    currency: 'IRR',
    workshopOrganizationId: 'ORG-WORKSHOP',
  };

  const usage = {
    id: 'USG_1',
    organizationId: 'ORG-A',
    assetId: 'AST_1',
    driverId: null,
    assignmentId: null,
    periodStart: '2026-09-25T06:00:00.000Z',
    periodEnd: '2026-09-25T14:00:00.000Z',
    hours: '7.5',
    kilometres: null,
    hourMeter: null,
    odometer: null,
    source: 'MANUAL',
    recordedAt: '2026-09-25T14:05:00.000Z',
    recordedBy: 'USR-RECORDER',
  };

  interface Call {
    url: string;
    headers: Record<string, string>;
  }

  function client(respond: (call: Call) => Promise<Response> | Response, timeoutMs = 1000) {
    const calls: Call[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      const call = { url, headers: init.headers as Record<string, string> };
      calls.push(call);
      return respond(call);
    }) as unknown as typeof fetch;
    return {
      calls,
      facts: new SourceFactsClient({
        maintenanceBaseUrl: 'http://maintenance.internal:3105/',
        fleetBaseUrl: 'http://fleet.internal:3104',
        timeoutMs,
        tokens,
        fetch: fake,
      }),
    };
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('asks the owner with a token for exactly that service and that organization', async () => {
    const { calls, facts } = client(() => json(approval));

    await expect(facts.maintenanceRequest('ORG-A', 'MNT_1')).resolves.toEqual(approval);

    expect(calls[0]!.url).toBe(
      'http://maintenance.internal:3105/v1/internal/maintenance-requests/MNT_1',
    );
    // The organization is inside the signature, never a header (ADR-035).
    expect(calls[0]!.headers).not.toHaveProperty('x-organization-id');
    const claims = await tokens.verify(
      calls[0]!.headers['x-internal-token']!,
      'maintenance-service',
    );
    expect(claims).toMatchObject({
      callerService: 'economic-service',
      purpose: 'SERVICE',
      organizationId: 'ORG-A',
    });
  });

  it('reads a usage record from fleet-service the same way', async () => {
    const { calls, facts } = client(() => json(usage));

    await expect(facts.usageRecord('ORG-A', 'USG_1')).resolves.toEqual(usage);
    expect(calls[0]!.url).toBe('http://fleet.internal:3104/v1/internal/usage-records/USG_1');
    const claims = await tokens.verify(calls[0]!.headers['x-internal-token']!, 'fleet-service');
    expect(claims.organizationId).toBe('ORG-A');
  });

  it('answers "no such record" for a 404, which the consumer turns into a refusal', async () => {
    const { facts } = client(() => json({ code: 'NOT_FOUND' }, 404));
    await expect(facts.maintenanceRequest('ORG-A', 'MNT_1')).resolves.toBeNull();
  });

  it.each<[string, () => Response | Promise<Response>]>([
    ['a 403 from a misconfigured allowlist', () => json({ code: 'FORBIDDEN' }, 403)],
    ['a 5xx', () => json({ code: 'INTERNAL_ERROR' }, 500)],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a body of the wrong shape', () => json({ ...approval, totalCostMinor: 450000 })],
    ['an answer about another record', () => json({ ...approval, id: 'MNT_2' })],
    [
      'a refused connection',
      () => {
        throw new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.5:3105');
      },
    ],
  ])('never says yes for %s: it is retried as UPSTREAM_UNAVAILABLE', async (_case, respond) => {
    const { facts } = client(respond);

    const failure = await facts.maintenanceRequest('ORG-A', 'MNT_1').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RastaError);
    expect((failure as RastaError).code).toBe('UPSTREAM_UNAVAILABLE');
    // Nothing from the failure leaks into what ends up in a DLQ header.
    expect(String((failure as RastaError).message)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|html/);
  });

  it('times out as UPSTREAM_TIMEOUT, and never waits forever', async () => {
    const { facts } = client(
      ({ url }) =>
        new Promise<Response>((_resolve, reject) => {
          void url;
          setTimeout(() => reject(new Error('aborted')), 50);
        }),
      10,
    );

    await expect(facts.maintenanceRequest('ORG-A', 'MNT_1')).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
  });

  it('escapes the identifier, so an event cannot steer the request to another path', async () => {
    const { calls, facts } = client(() => json({ code: 'NOT_FOUND' }, 404));
    await facts.maintenanceRequest('ORG-A', '../../v1/wallets');
    expect(calls[0]!.url).toBe(
      'http://maintenance.internal:3105/v1/internal/maintenance-requests/..%2F..%2Fv1%2Fwallets',
    );
  });
});
