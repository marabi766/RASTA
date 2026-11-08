import { REQUEST_CONTEXT_ROUTES, RedirectRefusedError, withRedirectProbe } from '@rasta/testing';

import { expect, test, type APIRequestContext } from './expect';

/**
 * The API request contexts this suite hands to specs refuse redirects (Q-155,
 * PR #492 r1 F2): the `request` fixture and `newApiContext()`. Specs send
 * bearers, password grants and signed storage URLs through them, and an
 * unguarded context follows a 307/308 to another origin with the body. Needs
 * no live stack: the two origins are loopback servers of the runner's own.
 */
test.describe('guarded API request contexts', () => {
  for (const status of [307, 308]) {
    test(`the request fixture refuses a ${status} to another origin`, async ({ request }) => {
      await withRedirectProbe({ body: { ok: true }, status }, async (probe) => {
        const sent = request.post(probe.baseUrl, {
          headers: { authorization: 'Bearer fixture-sentinel' },
          data: { password: 'fixture-sentinel' },
        });
        await expect(sent).rejects.toBeInstanceOf(RedirectRefusedError);
        expect(probe.sent).toHaveLength(1);
        expect(probe.target).toHaveLength(0);
      });
    });

    test(`newApiContext() refuses a ${status} to another origin`, async ({ newApiContext }) => {
      const context = await newApiContext();
      try {
        await withRedirectProbe({ body: { ok: true }, status }, async (probe) => {
          const method = status === 307 ? 'post' : 'put';
          await expect(context[method](probe.baseUrl, { data: 'bytes' })).rejects.toBeInstanceOf(
            RedirectRefusedError,
          );
          expect(probe.target).toHaveLength(0);
        });
      } finally {
        await context.dispose();
      }
    });
  }

  // These contexts never pass through guardRequestContext's proxy.
  for (const [route, reach] of Object.entries(REQUEST_CONTEXT_ROUTES)) {
    for (const status of [307, 308]) {
      for (const holderName of ['page', 'context'] as const) {
        test(`${holderName}.request via ${route} refuses ${status}`, async ({ page, context }) => {
          const api = reach(holderName === 'page' ? page : context) as APIRequestContext;
          for (const method of [
            'post',
            'put',
            'patch',
            'delete',
            'get',
            'head',
            'fetch',
          ] as const) {
            await withRedirectProbe({ body: { ok: true }, status }, async (probe) => {
              await expect(
                api[method](probe.baseUrl, {
                  headers: { authorization: 'Bearer route-sentinel' },
                  ...(method === 'head' ? {} : { data: 'route-sentinel' }),
                  maxRedirects: 9,
                }),
              ).rejects.toBeInstanceOf(RedirectRefusedError);
              expect(probe.sent).toHaveLength(1);
              expect(probe.target).toHaveLength(0);
            });
          }
        });
      }
    }
  }
});
