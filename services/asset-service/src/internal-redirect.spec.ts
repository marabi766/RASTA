import { randomBytes } from 'node:crypto';
import { InternalTokenService, createSystemContext, runWithContext } from '@rasta/nest-common';
import { REDIRECT_CASES, withRedirectProbe } from '@rasta/testing';
import { AssetWorkStateClient } from './consumers/work-state';
import { DocumentLookupClient } from './asset/document-lookup';
import { TransferClearanceClient } from './asset/transfer-clearance';

const tokens = new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300);
afterEach(() => jest.restoreAllMocks());

describe('document lookup rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: {
            id: 'DOC_1',
            organizationId: 'ORG_A',
            status: 'REGISTERED',
            ownerResourceType: 'Asset',
            ownerResourceId: 'AST_1',
          },
        },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new DocumentLookupClient({ baseUrl, timeoutMs: 2000, tokens, fetch: probe.fetch }).find(
              'DOC_1',
              'ORG_A',
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

describe('transfer clearance POST rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: {
            assetId: 'AST_1',
            fenceId: 'FNC_1',
            clear: true,
            fencedUntil: '2026-10-01T09:10:00.000Z',
            openAssignments: 0,
          },
        },
        async (probe) => {
          const { baseUrl } = probe;
          const options = { baseUrl, timeoutMs: 2000, tokens, fetch: probe.fetch };
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new TransferClearanceClient({
              ...options,
              baseUrls: { 'fleet-service': baseUrl, 'maintenance-service': baseUrl },
              fenceTtlSeconds: 600,
            }).ask('fleet-service', 'ORG_A', 'AST_1', 'FNC_1'),
          );
          if (status === 200) await expect(result).resolves.toBeDefined();
          else await expect(result).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
          expect(probe.sent).toHaveLength(1);
          expect(probe.target).toEqual([]);
          for (const request of probe.sent) {
            expect(request.method).toBe('POST');
            expect(request.headers['x-internal-token']).toEqual(expect.any(String));
          }
        },
      );
    },
  );
});

describe('work state concurrent exchanges rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: { assetId: 'AST_1', activeAssignment: false, inMaintenance: false },
        },
        async (probe) => {
          const { baseUrl } = probe;
          const exchanges: Promise<Response>[] = [];
          const trackedFetch: typeof fetch = (...args) => {
            const pending = probe.fetch(...args);
            exchanges.push(pending);
            return pending;
          };
          const options = { baseUrl, timeoutMs: 2000, tokens, fetch: trackedFetch };
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new AssetWorkStateClient({
              fleet: options,
              maintenance: options,
              from: 'asset-service',
            }).read('ORG_A', 'AST_1'),
          );
          if (status === 200) await expect(result).resolves.toBeDefined();
          else await expect(result).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
          await Promise.allSettled(exchanges);
          expect(probe.sent).toHaveLength(2);
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

it.each(REDIRECT_CASES)(
  'clearance cleanup DELETE $status sameOrigin=$sameOrigin sends one request and retains best-effort release semantics',
  async ({ status, sameOrigin }) => {
    await withRedirectProbe({ status, sameOrigin, body: {} }, async (probe) => {
      const client = new TransferClearanceClient({
        baseUrls: { 'fleet-service': probe.baseUrl, 'maintenance-service': probe.baseUrl },
        timeoutMs: 2000,
        fenceTtlSeconds: 600,
        tokens,
        fetch: probe.fetch,
      });
      await expect(
        client.release('fleet-service', 'ORG_A', 'AST_1', 'FNC_1'),
      ).resolves.toBeUndefined();
      expect(probe.sent).toHaveLength(1);
      expect(probe.sent[0].method).toBe('DELETE');
      expect(probe.target).toEqual([]);
    });
  },
);
