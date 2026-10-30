import { RedirectRefusedError, withRedirectProbe } from '@rasta/testing';

import { expect, test } from './expect';

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
});
