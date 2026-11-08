import {
  REQUEST_CONTEXT_ROUTES,
  rawContextFromFactory,
  RedirectRefusedError,
  withRedirectProbe,
} from '@rasta/testing';

import { newApiContext, type APIRequestContext } from '../../src/expect';
import { expect, test } from '../../src/api';

/**
 * The harness's Playwright API contexts refuse redirects (Q-155, PR #492 r1
 * F2), as `send()` does for the actors: the `request` fixture (and with it the
 * anonymous probe) and `newApiContext()` (global setup). The two origins are
 * loopback servers of the runner's own; nothing here touches the stack.
 */
test.describe('guarded API request contexts', () => {
  for (const status of [307, 308]) {
    test(`the request fixture refuses a ${status} to another origin`, async ({ request }) => {
      await withRedirectProbe({ body: { ok: true }, status }, async (probe) => {
        await expect(
          request.post(probe.baseUrl, { data: { password: 'harness-sentinel' } }),
        ).rejects.toBeInstanceOf(RedirectRefusedError);
        expect(probe.sent).toHaveLength(1);
        expect(probe.target).toHaveLength(0);
      });
    });

    test(`newApiContext() refuses a ${status} to another origin`, async () => {
      const context = await newApiContext();
      try {
        await withRedirectProbe({ body: { ok: true }, status }, async (probe) => {
          await expect(context.get(probe.baseUrl)).rejects.toBeInstanceOf(RedirectRefusedError);
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
      test(`factory context via ${route} refuses ${status}`, async ({ playwright }) => {
        const raw = (await rawContextFromFactory(playwright)) as APIRequestContext;
        try {
          const api = reach({ request: raw }) as APIRequestContext;
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
        } finally {
          await raw.dispose();
        }
      });
    }
  }
});
