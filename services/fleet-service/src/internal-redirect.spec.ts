import { randomBytes } from 'node:crypto';
import { InternalTokenService, createSystemContext, runWithContext } from '@rasta/nest-common';
import { REDIRECT_CASES, withRedirectProbe } from '@rasta/testing';
import { AssetSnapshotClient } from './consumers/replica-sources';
import { InsurancePolicyClient } from './consumers/replica-sources';
import { MaintenanceStateClient } from './consumers/replica-sources';
import { TransferRecordClient } from './fleet/transfer-record';

const tokens = new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300);
afterEach(() => jest.restoreAllMocks());

describe('transfer record rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        { status, sameOrigin, body: { assetId: 'AST_1', transferId: 'FNC_1', recorded: true } },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new TransferRecordClient({
              baseUrl,
              timeoutMs: 2000,
              tokens,
              fetch: probe.fetch,
            }).resolve('ORG_A', 'AST_1', 'FNC_1'),
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

describe('asset snapshot rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: {
            transferred: false,
            assetId: 'AST_1',
            organizationId: 'ORG_A',
            status: 'ACTIVE',
            name: 'asset',
            type: 'TRUCK',
            assetTag: null,
            transferGeneration: 0,
          },
        },
        async (probe) => {
          const { baseUrl } = probe;
          const options = { baseUrl, timeoutMs: 2000, tokens, fetch: probe.fetch };
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new AssetSnapshotClient({ ...options, from: 'fleet-service' }).snapshot(
              'ORG_A',
              'AST_1',
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

describe('insurance policy rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: {
            transferred: false,
            assetId: 'AST_1',
            policyId: 'POL_1',
            counts: false,
            reason: 'EXPIRED',
          },
        },
        async (probe) => {
          const { baseUrl } = probe;
          const options = { baseUrl, timeoutMs: 2000, tokens, fetch: probe.fetch };
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new InsurancePolicyClient({ ...options, from: 'fleet-service' }).verify(
              'ORG_A',
              'AST_1',
              'POL_1',
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

describe('maintenance state rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        { status, sameOrigin, body: { assetId: 'AST_1', inMaintenance: false } },
        async (probe) => {
          const { baseUrl } = probe;
          const options = { baseUrl, timeoutMs: 2000, tokens, fetch: probe.fetch };
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new MaintenanceStateClient({ ...options, from: 'fleet-service' }).inMaintenance(
              'ORG_A',
              'AST_1',
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
