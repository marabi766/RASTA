import { randomBytes } from 'node:crypto';
import { InternalTokenService, createSystemContext, runWithContext } from '@rasta/nest-common';
import { REDIRECT_CASES, withRedirectProbe } from '@rasta/testing';
import { AuditLookupClient } from './audit-correction/audit-lookup.client';

const tokens = new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300);
afterEach(() => jest.restoreAllMocks());

describe('audit target rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        {
          status,
          sameOrigin,
          body: { id: 'AUD_1', organizationId: 'ORG_A', occurredAt: '2026-10-01T09:00:00.000Z' },
        },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new AuditLookupClient({
              baseUrl,
              timeoutMs: 2000,
              tokens,
              fetch: probe.fetch,
            }).findTarget('AUD_1', new Date('2026-10-01T09:00:00.000Z')),
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
