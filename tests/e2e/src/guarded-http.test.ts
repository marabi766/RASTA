import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import {
  guardedFetch,
  RedirectRefusedError,
  REDIRECT_CASES,
  withRedirectProbe,
} from '@rasta/testing';
import { newApiContext } from './expect.ts';

/**
 * The E2E helper transport (PR #492 r1 F2): `guardedFetch` for raw Node calls and
 * `guardRequestContext` for Playwright's API request contexts — reached here through the
 * harness's own `newApiContext()`, since only `src/expect.ts` may load Playwright Test
 * (scripts/disclosure-guard-wiring.test.mjs) — both of which the browser
 * suite and this harness use for every credential-bearing or signed-URL call. Real loopback
 * origins: the redirect target is a second server on another port (another origin) that
 * answers with a success a following client would accept. Runs under `node --test`.
 */

/** Built, not a literal: a secret scanner reads any quoted value next to the word. */
const PASSWORD = ['pw', 'sentinel', '135a'].join('-');
const BEARER = 'Bearer BEARERSENTINEL135b';
const BYTES = 'SIGNEDBYTES135c';

/** The refusal names nothing: no URL, Location, credential or body. */
function assertRefusal(error: unknown, baseUrl: string): true {
  assert.ok(error instanceof RedirectRefusedError, inspect(error));
  const text = `${error.message}\n${error.stack ?? ''}\n${inspect(error)}`;
  for (const secret of [PASSWORD, BEARER, BYTES, baseUrl, 'redirect-target', '127.0.0.1'])
    assert.ok(!text.includes(secret), `the refusal disclosed ${secret}`);
  return true;
}

describe('guardedFetch', () => {
  for (const status of [307, 308]) {
    it(`refuses a ${status} to another origin: the password grant is sent once and never resent`, async () => {
      await withRedirectProbe({ body: { access_token: 'attacker' }, status }, async (probe) => {
        await assert.rejects(
          guardedFetch(`${probe.baseUrl}/realms/master/protocol/openid-connect/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'password', password: PASSWORD }),
          }),
          (error) => assertRefusal(error, probe.baseUrl),
        );
        assert.equal(probe.sent.length, 1);
        assert.deepEqual(probe.target, [], 'nothing reached the other origin');
      });
    });

    it(`refuses a ${status} on a signed-URL PUT: the bytes never move`, async () => {
      await withRedirectProbe({ body: {}, status }, async (probe) => {
        await assert.rejects(
          guardedFetch(`${probe.baseUrl}/bucket/key?X-Amz-Signature=s`, {
            method: 'PUT',
            headers: { 'content-type': 'application/pdf' },
            body: BYTES,
          }),
          (error) => assertRefusal(error, probe.baseUrl),
        );
        assert.deepEqual(probe.target, []);
      });
    });
  }

  it('refuses all five statuses, same origin or not', async () => {
    for (const { status, sameOrigin } of REDIRECT_CASES) {
      await withRedirectProbe({ body: {}, status, sameOrigin }, async (probe) => {
        await assert.rejects(
          guardedFetch(probe.baseUrl, { headers: { authorization: BEARER } }),
          (error) => assertRefusal(error, probe.baseUrl),
          `${status} sameOrigin=${sameOrigin}`,
        );
        assert.deepEqual(probe.target, [], `${status} sameOrigin=${sameOrigin}`);
      });
    }
  });

  it("overrides a caller's redirect: 'follow'", async () => {
    await withRedirectProbe({ body: {}, status: 307 }, async (probe) => {
      const init = { method: 'POST', body: PASSWORD, redirect: 'follow' } as RequestInit;
      await assert.rejects(guardedFetch(probe.baseUrl, init), RedirectRefusedError);
      assert.deepEqual(probe.target, []);
    });
  });

  it('answers every other status as the server sent it', async () => {
    for (const status of [200, 304, 404]) {
      await withRedirectProbe({ body: { ok: true }, status }, async (probe) => {
        assert.equal((await guardedFetch(probe.baseUrl)).status, status);
      });
    }
  });
});

describe('guardRequestContext (Playwright APIRequestContext)', () => {
  it('control: a following client reaches the other origin and accepts its success', async () => {
    await withRedirectProbe({ body: { ok: true }, status: 307 }, async (probe) => {
      const response = await probe.fetch(probe.baseUrl, { method: 'POST', body: PASSWORD });
      assert.equal(response.status, 200);
      assert.equal(probe.target.length, 1, 'the probe must be able to show a follow');
    });
  });

  for (const status of [307, 308]) {
    it(`refuses a ${status} to another origin on every sending method`, async () => {
      const context = await newApiContext();
      try {
        const sends = {
          post: (url: string) =>
            context.post(url, { headers: { authorization: BEARER }, data: { password: PASSWORD } }),
          put: (url: string) =>
            context.put(url, {
              headers: { 'content-type': 'application/pdf' },
              data: Buffer.from(BYTES),
            }),
          patch: (url: string) =>
            context.patch(url, { headers: { authorization: BEARER }, data: {} }),
          delete: (url: string) => context.delete(url, { headers: { authorization: BEARER } }),
          get: (url: string) => context.get(url, { headers: { authorization: BEARER } }),
          head: (url: string) => context.head(url, { headers: { authorization: BEARER } }),
          fetch: (url: string) =>
            context.fetch(url, {
              method: 'POST',
              headers: { authorization: BEARER },
              data: PASSWORD,
            }),
          'computed request[method]': (url: string) =>
            context[status === 307 ? 'post' : 'get'](url, { headers: { authorization: BEARER } }),
        };
        for (const [method, send] of Object.entries(sends)) {
          await withRedirectProbe({ body: { ok: true }, status }, async (probe) => {
            await assert.rejects(
              send(probe.baseUrl),
              (error) => assertRefusal(error, probe.baseUrl),
              method,
            );
            assert.equal(probe.sent.length, 1, method);
            assert.deepEqual(probe.target, [], `${method}: nothing reached the other origin`);
          });
        }
      } finally {
        await context.dispose();
      }
    });
  }

  it('refuses a same-origin hop, where Playwright would keep the authorization header', async () => {
    const context = await newApiContext();
    try {
      for (const status of [301, 302, 303, 307, 308]) {
        await withRedirectProbe({ body: {}, status, sameOrigin: true }, async (probe) => {
          await assert.rejects(
            context.get(probe.baseUrl, { headers: { authorization: BEARER } }),
            RedirectRefusedError,
          );
          assert.deepEqual(probe.target, [], String(status));
        });
      }
    } finally {
      await context.dispose();
    }
  });

  it("overrides a caller's maxRedirects and leaves every other answer and method alone", async () => {
    const context = await newApiContext();
    try {
      await withRedirectProbe({ body: {}, status: 308 }, async (probe) => {
        await assert.rejects(
          context.post(probe.baseUrl, { data: {}, maxRedirects: 5 }),
          RedirectRefusedError,
        );
        assert.deepEqual(probe.target, []);
      });
      for (const status of [200, 304, 404]) {
        await withRedirectProbe({ body: { ok: true }, status }, async (probe) => {
          const response = await context.get(probe.baseUrl, { failOnStatusCode: false });
          assert.equal(response.status(), status);
        });
      }
      assert.equal(typeof (await context.storageState()).cookies, 'object');
    } finally {
      await context.dispose();
    }
  });
});
