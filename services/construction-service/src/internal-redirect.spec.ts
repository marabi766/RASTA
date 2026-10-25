import { randomBytes } from 'node:crypto';
import { InternalTokenService, createSystemContext, runWithContext } from '@rasta/nest-common';
import { REDIRECT_CASES, withRedirectProbe } from '@rasta/testing';
import { MembershipClient } from './tender/membership.client';
import { OrganizationDirectory } from './organization/organization-directory';
import { ProcurementThresholdPolicy } from './organization/procurement-threshold-policy';
import { SupplierSnapshotClient } from './tender/supplier-snapshot.client';
import { TenderEvidenceClient } from './tender/tender-evidence.client';

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
                CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS: 2000,
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

describe('threshold policy rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        { status, sameOrigin, body: { organizationId: 'ORG_A', policy: null } },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new ProcurementThresholdPolicy(
              {
                ORGANIZATION_SERVICE_URL: baseUrl,
                IDENTITY_SERVICE_URL: baseUrl,
                SUPPLIER_SERVICE_URL: baseUrl,
                AUDIT_SERVICE_URL: baseUrl,
                CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_IDENTITY_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_SUPPLIER_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_AUDIT_REQUEST_TIMEOUT_MS: 2000,
              } as never,
              tokens,
            ).get('ORG_A'),
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

describe('membership rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: { userId: 'USR_1', memberships: [], asOf: '2026-10-01T09:00:00.000Z' },
        },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new MembershipClient(
              {
                ORGANIZATION_SERVICE_URL: baseUrl,
                IDENTITY_SERVICE_URL: baseUrl,
                SUPPLIER_SERVICE_URL: baseUrl,
                AUDIT_SERVICE_URL: baseUrl,
                CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_IDENTITY_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_SUPPLIER_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_AUDIT_REQUEST_TIMEOUT_MS: 2000,
              } as never,
              tokens,
            ).fetchMemberships('USR_1'),
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

describe('supplier snapshot rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: {
            items: [],
            nextCursor: null,
            hasMore: false,
            snapshotAt: '2026-10-01T09:00:00.000Z',
          },
        },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new SupplierSnapshotClient(
              {
                ORGANIZATION_SERVICE_URL: baseUrl,
                IDENTITY_SERVICE_URL: baseUrl,
                SUPPLIER_SERVICE_URL: baseUrl,
                AUDIT_SERVICE_URL: baseUrl,
                CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_IDENTITY_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_SUPPLIER_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_AUDIT_REQUEST_TIMEOUT_MS: 2000,
              } as never,
              tokens,
            ).fetchPage(null, 100),
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

describe('tender evidence rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: {
            tenderId: 'TND_1',
            genesis: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            links: [],
          },
        },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new TenderEvidenceClient(
              {
                ORGANIZATION_SERVICE_URL: baseUrl,
                IDENTITY_SERVICE_URL: baseUrl,
                SUPPLIER_SERVICE_URL: baseUrl,
                AUDIT_SERVICE_URL: baseUrl,
                CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_IDENTITY_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_SUPPLIER_REQUEST_TIMEOUT_MS: 2000,
                CONSTRUCTION_AUDIT_REQUEST_TIMEOUT_MS: 2000,
              } as never,
              tokens,
            ).fetchChain('ORG_A', 'TND_1'),
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
