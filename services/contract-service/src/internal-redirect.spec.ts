import { randomBytes } from 'node:crypto';
import { InternalTokenService, createSystemContext, runWithContext } from '@rasta/nest-common';
import { REDIRECT_CASES, withRedirectProbe } from '@rasta/testing';
import { AwardSourceClient } from './award/award-source.client';
import { ObligationSourceClient } from './settlement/obligation-source.client';
import { OrganizationDirectory } from './organization/organization-directory';

const tokens = new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300);
afterEach(() => jest.restoreAllMocks());

describe('organization directory rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        { status, sameOrigin, body: { id: 'ORG_A', hierarchyVersion: 1 } },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new OrganizationDirectory(
              {
                ORGANIZATION_SERVICE_URL: baseUrl,
                IDENTITY_SERVICE_URL: baseUrl,
                SUPPLIER_SERVICE_URL: baseUrl,
                AUDIT_SERVICE_URL: baseUrl,
                CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_IDENTITY_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_SUPPLIER_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_AUDIT_REQUEST_TIMEOUT_MS: 2000,
              } as never,
              tokens,
            ).isWithin('ORG_A', 'ORG_A'),
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

describe('award source rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: {
            tenderId: 'TND_1',
            projectId: 'PRJ_1',
            status: 'AWARDED',
            bidId: 'BID_1',
            bidderOrganizationId: 'ORG_B',
            amountMinor: '10',
            matrixDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            awardedAt: '2026-10-01T09:00:00.000Z',
            awardedBy: 'USR_1',
          },
        },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new AwardSourceClient({ baseUrl, timeoutMs: 2000, tokens, fetch: probe.fetch }).award(
              'ORG_A',
              'TND_1',
            ),
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

describe('settlement obligation rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: {
            obligationId: 'TXN_1',
            statementId: 'STM_1',
            status: 'SETTLED',
            amountMinor: '10',
            currency: 'IRR',
            payerOrganizationId: 'ORG_A',
            beneficiaryOrganizationId: 'ORG_B',
            settlementId: 'STL_1',
            settledAt: '2026-10-01T09:00:00.000Z',
            settledAmountMinor: '10',
            fullySettled: true,
          },
        },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new ObligationSourceClient({
              baseUrl,
              timeoutMs: 2000,
              tokens,
              fetch: probe.fetch,
            }).obligation('ORG_A', 'STM_1'),
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
