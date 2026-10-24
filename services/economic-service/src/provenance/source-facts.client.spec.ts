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

  const statement = {
    statementId: 'STM_1',
    contractId: 'CTR_1',
    status: 'APPROVED',
    netMinor: '9223372036854775807',
    currency: 'IRR',
    payerOrganizationId: 'ORG-EMPLOYER',
    beneficiaryOrganizationId: 'ORG-CONTRACTOR',
    approvedAt: '2026-10-16T11:00:00.000Z',
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
        contractBaseUrl: 'http://contract.internal:3111/',
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

  it('answers "no such record" only for the owner’s own NOT_FOUND about that record', async () => {
    // What the global exception filter renders for RastaError.notFound().
    const notFound = (message: string) =>
      json({ code: 'NOT_FOUND', message, correlationId: 'c', timestamp: 't' }, 404);

    const requests = client(() => notFound('MaintenanceRequest not found'));
    await expect(requests.facts.maintenanceRequest('ORG-A', 'MNT_1')).resolves.toBeNull();
    const usage = client(() => notFound('UsageRecord not found'));
    await expect(usage.facts.usageRecord('ORG-A', 'USG_1')).resolves.toBeNull();
  });

  it.each<[string, () => Response]>([
    // A rolling deploy, an old version without the route, a wrong base path:
    // Nest renders these with the same code but its own message.
    [
      'a route that does not exist',
      () =>
        json(
          { code: 'NOT_FOUND', message: 'Cannot GET /v1/internal/maintenance-requests/MNT_1' },
          404,
        ),
    ],
    ['a proxy page', () => new Response('<html>404</html>', { status: 404 })],
    ['an empty 404', () => new Response(null, { status: 404 })],
    [
      'a NOT_FOUND about another kind of record',
      () => json({ code: 'NOT_FOUND', message: 'Asset not found' }, 404),
    ],
  ])(
    'does not take %s as proof of absence: retried as UPSTREAM_UNAVAILABLE',
    async (_case, respond) => {
      // PR #110 review #4: "no such record" dead-letters the event at once, so
      // only the owner's own answer about the record may say it.
      const { facts } = client(respond);
      await expect(facts.maintenanceRequest('ORG-A', 'MNT_1')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
    },
  );

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

  describe('a statement, from contract-service (ADR-068 § 6 (2))', () => {
    it('asks with an X-Internal-Token for contract-service, signed for the employer, and keeps the net exact at 2^63 - 1', async () => {
      const { calls, facts } = client(() => json(statement));

      await expect(facts.statement('ORG-EMPLOYER', 'STM_1')).resolves.toEqual(statement);

      expect(calls[0]!.url).toBe('http://contract.internal:3111/v1/internal/statements/STM_1');
      // The route's apiKey scheme: the internal token alone, no Authorization (#320).
      expect(calls[0]!.headers).not.toHaveProperty('authorization');
      expect(calls[0]!.headers).not.toHaveProperty('x-organization-id');
      const claims = await tokens.verify(
        calls[0]!.headers['x-internal-token']!,
        'contract-service',
      );
      expect(claims).toMatchObject({
        callerService: 'economic-service',
        purpose: 'SERVICE',
        organizationId: 'ORG-EMPLOYER',
      });
    });

    it('returns a statement in any status as stated: refusing it is the consumer’s verdict, not a parse failure', async () => {
      const draft = { ...statement, status: 'DRAFT', approvedAt: null };
      const { facts } = client(() => json(draft));
      await expect(facts.statement('ORG-EMPLOYER', 'STM_1')).resolves.toEqual(draft);
    });

    it('answers "no such statement" only for contract-service’s own Statement not found', async () => {
      const found = client(() => json({ code: 'NOT_FOUND', message: 'Statement not found' }, 404));
      await expect(found.facts.statement('ORG-OTHER', 'STM_1')).resolves.toBeNull();

      const route = client(() =>
        json({ code: 'NOT_FOUND', message: 'Cannot GET /v1/internal/statements/STM_1' }, 404),
      );
      await expect(route.facts.statement('ORG-EMPLOYER', 'STM_1')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
    });

    it.each<[string, () => Response]>([
      ['a net past BIGINT', () => json({ ...statement, netMinor: '9223372036854775808' })],
      ['a negative net', () => json({ ...statement, netMinor: '-1' })],
      ['a numeric net', () => json({ ...statement, netMinor: 7350000 })],
      ['an answer about another statement', () => json({ ...statement, statementId: 'STM_2' })],
      ['a body without a payer', () => json({ ...statement, payerOrganizationId: undefined })],
      [
        'a 403 for a token signed for no organization',
        () => json({ code: 'SERVICE_TENANT_CONTEXT_INVALID' }, 403),
      ],
      ['a 503', () => json({ code: 'INTERNAL_ERROR' }, 503)],
    ])('never says yes for %s: retried as UPSTREAM_UNAVAILABLE', async (_case, respond) => {
      const { facts } = client(respond);
      await expect(facts.statement('ORG-EMPLOYER', 'STM_1')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
    });

    // Task 011: the bound's refinement ran on a net the pattern had refused, and `BigInt` threw a
    // SyntaxError carrying the owner's text out of `read` — retried, then dead-lettered as
    // MAX_RETRIES_EXCEEDED with that text in x-dlq-error. It is a body that does not parse.
    it.each([
      ['a fractional net', '1.5'],
      ['a net in letters', 'abc'],
      ['a net with an exponent', '1e3'],
      ['a net that is free text', 'private-invoice-reference-123'],
      ['an empty net', ''],
      ['a net with a leading space', ' 1'],
      ['a net with a plus sign', '+1'],
      ['a hexadecimal net', '0x10'],
    ])(
      'never says yes for %s: UPSTREAM_UNAVAILABLE, never a SyntaxError, the text nowhere',
      async (_case, netMinor) => {
        const { calls, facts } = client(() => json({ ...statement, netMinor }));
        const error = await facts.statement('ORG-EMPLOYER', 'STM_1').catch((e: unknown) => e);

        expect(error).toBeInstanceOf(RastaError);
        expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
        expect(
          JSON.stringify({ ...(error as RastaError), message: (error as Error).message }),
        ).not.toContain('private-invoice-reference-123');
        // Still asked as the organization the event names, and only as it.
        const claims = await tokens.verify(
          calls[0]!.headers['x-internal-token']!,
          'contract-service',
        );
        expect(claims.organizationId).toBe('ORG-EMPLOYER');
      },
    );

    it.each([
      ['zero', '0'],
      ['zero with a leading zero', '00'],
      ['one with a leading zero', '01'],
      ['the largest BIGINT', '9223372036854775807'],
      ['a long run of leading zeros (no digit limit)', `${'0'.repeat(30)}7350000`],
    ])('takes %s as the owner wrote it, byte for byte, as before', async (_case, netMinor) => {
      const { facts } = client(() => json({ ...statement, netMinor }));
      await expect(facts.statement('ORG-EMPLOYER', 'STM_1')).resolves.toMatchObject({ netMinor });
    });

    it('times out as UPSTREAM_TIMEOUT', async () => {
      const { facts } = client(
        () =>
          new Promise<Response>((_resolve, reject) => setTimeout(() => reject(new Error('x')), 50)),
        10,
      );
      await expect(facts.statement('ORG-EMPLOYER', 'STM_1')).rejects.toMatchObject({
        code: 'UPSTREAM_TIMEOUT',
      });
    });
  });

  it('escapes the identifier, so an event cannot steer the request to another path', async () => {
    const { calls, facts } = client(() => json({ code: 'NOT_FOUND' }, 404));
    await facts.maintenanceRequest('ORG-A', '../../v1/wallets').catch(() => undefined);
    expect(calls[0]!.url).toBe(
      'http://maintenance.internal:3105/v1/internal/maintenance-requests/..%2F..%2Fv1%2Fwallets',
    );
  });
});
