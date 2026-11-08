import { randomBytes } from 'node:crypto';
import { InternalTokenService, createSystemContext, runWithContext } from '@rasta/nest-common';
import { REDIRECT_CASES, withRedirectProbe } from '@rasta/testing';
import { ProxyService, READINESS_PATH } from './proxy/proxy.service';

const tokens = new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300);
afterEach(() => jest.restoreAllMocks());

describe('gateway RELAY rejects authenticated redirects', () => {
  describe.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])('%s', (method) => {
    it.each([...REDIRECT_CASES, { status: 200, sameOrigin: false }])(
      '$status sameOrigin=$sameOrigin: one exchange and no credential forwarding',
      async ({ status, sameOrigin }) => {
        await withRedirectProbe(
          { status, sameOrigin, body: { items: [], hasMore: false } },
          async (probe) => {
            const { baseUrl } = probe;
            jest.spyOn(globalThis, 'fetch').mockImplementation(probe.fetch);
            const gateway = new ProxyService({ IDENTITY_SERVICE_URL: baseUrl } as never, tokens, {
              timeoutMs: 2000,
              failureThreshold: 1,
              organizationsToOpen: 1,
              resetAfterMs: 60000,
            });
            const caller = {
              ...createSystemContext({ correlationId: 'COR_1' }),
              organizationId: 'ORG_1',
            };
            const result = runWithContext(caller, () =>
              gateway.forward({
                service: 'identity',
                method,
                path: '/v1/users',
                query: '',
                headers: { authorization: 'Bearer user' },
                body: method === 'GET' ? undefined : { reason: 'test' },
              }),
            );
            if (status === 200) await expect(result).resolves.toBeDefined();
            else await expect(result).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
            // The gateway's own readiness check (FU-113) is no relayed exchange:
            // it carries no credential, and it never follows a redirect either.
            const relayed = probe.sent.filter((request) => request.url !== READINESS_PATH);
            expect(relayed).toHaveLength(1);
            expect(probe.target).toEqual([]);
            for (const request of relayed) {
              expect(request.method).toBe(method);
              expect(request.headers['x-internal-token']).toEqual(expect.any(String));
            }
            if (status !== 200) {
              const failure = await result.catch((error: unknown) => error);
              expect(JSON.stringify(failure)).not.toContain('redirect-body-must-not-be-trusted');
              expect(JSON.stringify(failure)).not.toContain('redirect-target');
              expect(failure).not.toHaveProperty('headers.location');
              expect(gateway.circuitStates().identity).toEqual({
                failures: 1,
                open: true,
                state: 'OPEN',
              });
              await expect(
                runWithContext(createSystemContext({ correlationId: 'COR_2' }), () =>
                  gateway.forward({
                    service: 'identity',
                    method,
                    path: '/v1/users',
                    query: '',
                    headers: {},
                    body: undefined,
                  }),
                ),
              ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
              expect(probe.sent.filter((request) => request.url !== READINESS_PATH)).toHaveLength(
                1,
              );
            }
          },
        );
      },
    );
  });
});
