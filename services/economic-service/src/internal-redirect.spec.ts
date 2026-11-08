import { randomBytes } from 'node:crypto';
import { InternalTokenService, createSystemContext, runWithContext } from '@rasta/nest-common';
import { REDIRECT_CASES, withRedirectProbe } from '@rasta/testing';
import { OrganizationHierarchy } from './organization/organization-hierarchy';
import { SourceFactsClient } from './provenance/source-facts.client';

const tokens = new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300);
afterEach(() => jest.restoreAllMocks());

describe('organization hierarchy rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        { status, sameOrigin, body: { id: 'ORG_A', hierarchyVersion: 1 } },
        async (probe) => {
          const { baseUrl } = probe;
          const options = { baseUrl, timeoutMs: 2000, tokens, fetch: probe.fetch };
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new OrganizationHierarchy(options).withinVersion('ORG_A', 'ORG_A'),
          );
          if (status === 200) await expect(result).resolves.toBeDefined();
          else await expect(result).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
          expect(probe.sent).toHaveLength(1);
          expect(probe.target).toEqual([]);
          for (const request of probe.sent) {
            expect(request.method).toBe('GET');
            expect(request.headers['x-internal-token']).toEqual(expect.any(String));
          }
        },
      );
    },
  );
});

describe('source statement rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: {
            statementId: 'STM_1',
            contractId: 'CTR_1',
            status: 'APPROVED',
            netMinor: '10',
            currency: 'IRR',
            payerOrganizationId: 'ORG_A',
            beneficiaryOrganizationId: 'ORG_B',
            approvedAt: '2026-10-01T09:00:00.000Z',
          },
        },
        async (probe) => {
          const { baseUrl } = probe;
          const options = { baseUrl, timeoutMs: 2000, tokens, fetch: probe.fetch };
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new SourceFactsClient({
              ...options,
              maintenanceBaseUrl: baseUrl,
              fleetBaseUrl: baseUrl,
              contractBaseUrl: baseUrl,
            }).statement('ORG_A', 'STM_1'),
          );
          if (status === 200) await expect(result).resolves.toBeDefined();
          else await expect(result).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
          expect(probe.sent).toHaveLength(1);
          expect(probe.target).toEqual([]);
          for (const request of probe.sent) {
            expect(request.method).toBe('GET');
            expect(request.headers['x-internal-token']).toEqual(expect.any(String));
          }
        },
      );
    },
  );
});
