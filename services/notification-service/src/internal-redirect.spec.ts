import { randomBytes } from 'node:crypto';
import { InternalTokenService, createSystemContext, runWithContext } from '@rasta/nest-common';
import { REDIRECT_CASES, withRedirectProbe } from '@rasta/testing';
import { IdentityHttpRecipientAdapter } from './recipients/identity-http.adapter';

const tokens = new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300);
afterEach(() => jest.restoreAllMocks());

describe('identity recipients rejects authenticated redirects', () => {
  it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
    '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        { status, sameOrigin, body: { items: [], hasMore: false, nextCursor: null } },
        async (probe) => {
          const { baseUrl } = probe;
          jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
          const result = runWithContext(createSystemContext({ correlationId: 'COR_1' }), () =>
            new IdentityHttpRecipientAdapter(
              { baseUrl, timeoutMs: 2000 },
              tokens,
              probe.fetch,
            ).resolve({
              organizationId: 'ORG_A',
              roles: ['FLEET_MANAGER'],
              limit: 500,
              correlationId: 'COR_1',
            }),
          );
          if (status === 200) await expect(result).resolves.toBeDefined();
          else await expect(result).rejects.toMatchObject({ reason: 'UNREACHABLE' });
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

it('a redirect on recipient page 2 fails the whole resolution without returning partial recipients', async () => {
  const user = {
    id: 'USR_1',
    status: 'ACTIVE',
    roles: ['FLEET_MANAGER'],
    email: 'one@example.test',
  };
  await withRedirectProbe(
    {
      firstPage: { items: [user], nextCursor: 'USR_1', hasMore: true },
      body: { items: [], nextCursor: null, hasMore: false },
    },
    async (probe) => {
      const adapter = new IdentityHttpRecipientAdapter(
        { baseUrl: probe.baseUrl, timeoutMs: 2000 },
        tokens,
        probe.fetch,
      );
      await expect(
        adapter.resolve({
          organizationId: 'ORG_A',
          roles: ['FLEET_MANAGER'],
          limit: 500,
          correlationId: 'COR_1',
        }),
      ).rejects.toMatchObject({ reason: 'UNREACHABLE' });
      expect(probe.sent).toHaveLength(2);
      expect(probe.sent[1].url).toContain('cursor=USR_1');
      expect(probe.target).toEqual([]);
    },
  );
});
