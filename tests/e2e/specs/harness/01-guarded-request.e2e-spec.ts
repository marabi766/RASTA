import { RedirectRefusedError, withRedirectProbe } from '@rasta/testing';

import { newApiContext } from '../../src/expect';
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
});
