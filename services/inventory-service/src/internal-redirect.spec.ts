import { randomBytes } from 'node:crypto';
import { InternalTokenService, createSystemContext, runWithContext } from '@rasta/nest-common';
import { REDIRECT_CASES, withRedirectProbe } from '@rasta/testing';
import { ReturnRequestSourceClient } from './return-shipment/return-request-source';

const tokens = new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300);
afterEach(() => jest.restoreAllMocks());

describe('return request GET rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: {
            returnRequestId: 'RET_1',
            orderId: 'ORD_1',
            buyerOrganizationId: 'ORG_B',
            supplierOrganizationId: 'ORG_A',
            status: 'AUTHORIZED',
            lines: [{ orderLineId: 'OLN_1', productId: 'PRD_1', quantity: 1 }],
            dispatchReservationId: null,
            dispatchReservedAt: null,
            partialDispatchAllowed: false,
          },
        },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new ReturnRequestSourceClient({
              baseUrl,
              timeoutMs: 2000,
              tokens,
              fetch: probe.fetch,
            }).read('ORG_A', 'RET_1'),
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

describe('return reservation POST rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: {
            returnRequestId: 'RET_1',
            orderId: 'ORD_1',
            buyerOrganizationId: 'ORG_B',
            supplierOrganizationId: 'ORG_A',
            status: 'AUTHORIZED',
            lines: [{ orderLineId: 'OLN_1', productId: 'PRD_1', quantity: 1 }],
            dispatchReservationId: 'RDR_1',
            dispatchReservedAt: '2026-10-01T09:00:00.000Z',
            partialDispatchAllowed: false,
          },
        },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new ReturnRequestSourceClient({
              baseUrl,
              timeoutMs: 2000,
              tokens,
              fetch: probe.fetch,
            }).reserve('ORG_A', 'RET_1'),
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
