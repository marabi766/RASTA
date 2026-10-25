import { randomBytes } from 'node:crypto';
import { InternalTokenService, createSystemContext, runWithContext } from '@rasta/nest-common';
import { REDIRECT_CASES, withRedirectProbe } from '@rasta/testing';
import { EconomicClient } from './economic/economic.client';
import { OrganizationHierarchy } from './organization/organization-hierarchy';
import { ReturnGoodsClient } from './returns/return-goods';

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

describe('return shipment rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        { status, sameOrigin, body: { returnRequestId: 'RET_1', returnShipment: null } },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new ReturnGoodsClient({
              baseUrl,
              timeoutMs: 2000,
              tokens,
              fetch: probe.fetch,
            }).shipmentOf('ORG_A', 'RET_1'),
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

describe('return withdrawal POST rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: {
            outcome: 'WITHDRAWN',
            returnRequestId: 'RET_1',
            reservationId: 'RDR_1',
            withdrawnAt: '2026-10-01T09:00:00.000Z',
            returnShipment: null,
          },
        },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new ReturnGoodsClient({
              baseUrl,
              timeoutMs: 2000,
              tokens,
              fetch: probe.fetch,
            }).withdraw('ORG_A', 'RET_1', 'RDR_1'),
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

describe('economic create POST rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: {
            id: 'TXN_1',
            organizationId: 'ORG_A',
            counterpartyOrganizationId: 'ORG_B',
            transactionType: 'MARKETPLACE_ORDER',
            status: 'HELD',
            grossAmountMinor: '10',
            commissionAmountMinor: '0',
            netAmountMinor: '10',
            currency: 'IRR',
            sourceType: 'ORDER',
            sourceReference: 'ORD_1',
          },
        },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new EconomicClient(
              { ECONOMIC_SERVICE_URL: baseUrl, ECONOMIC_REQUEST_TIMEOUT_MS: 2000 } as never,
              tokens,
            ).createObligation({
              orderId: 'ORD_1',
              buyerOrganizationId: 'ORG_A',
              supplierOrganizationId: 'ORG_B',
              totalAmountMinor: 10n,
              currency: 'IRR',
              correlationId: 'COR_1',
            }),
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

it('an obligation redirect on page 2 fails the entire reconciliation read', async () => {
  const row = {
    id: 'TXN_1',
    sourceType: 'ORDER',
    sourceReference: 'ORD_1',
    transactionType: 'MARKETPLACE_ORDER',
  };
  await withRedirectProbe(
    {
      firstPage: { items: [row], nextCursor: 'TXN_1', hasMore: true },
      body: { items: [], nextCursor: null, hasMore: false },
    },
    async (probe) => {
      const client = new EconomicClient(
        { ECONOMIC_SERVICE_URL: probe.baseUrl, ECONOMIC_REQUEST_TIMEOUT_MS: 2000 } as never,
        tokens,
      );
      jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
      await expect(
        client.findObligations({
          orderId: 'ORD_1',
          buyerOrganizationId: 'ORG_A',
          correlationId: 'COR_1',
        }),
      ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      expect(probe.sent).toHaveLength(2);
      expect(probe.sent[1].url).toContain('cursor=TXN_1');
      expect(probe.target).toEqual([]);
    },
  );
});
