import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expectActionSucceeded, postFromPage, type ActionSuccess } from './action-outcome';
import { expect, test, type Page, type Request } from './expect';

/**
 * The success oracle itself (PR #541 r1 F1), with no live stack: a loopback
 * server of the runner's own plays the portal — a page with a form, and an
 * action endpoint answered from a list — so each answer a refused submission
 * can get is put on the wire exactly, redirects included. The shape the specs
 * use: a first submission that succeeds, then a replay of it that is answered
 * otherwise — every one of those answers must fail the oracle, as it must fail
 * `session-tenant-pinning.spec.ts` and `usage.spec.ts`.
 */
const WALLET: ActionSuccess = { path: '/wallet' };

interface Answer {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}
const success = (): Answer => ({
  status: 303,
  headers: { 'x-action-redirect': '/wallet;push', 'content-type': 'text/x-component' },
  body: '0:{}\n',
});

// The button is the portal's client: a fetch action, as React sends one.
const PAGE =
  '<form action="/act" method="post"><input name="amountMinor" value="73000"></form>' +
  "<button onclick=\"fetch('/act', {method: 'POST', body: 'amountMinor=73000', " +
  "headers: {'next-action': 'a1b2', accept: 'text/x-component'}})\">top up</button>";

/** Opens the page; `answers` are given, in arrival order, to the POSTs to `/act`. */
async function portal(page: Page, answers: Answer[], run: () => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const answer: Answer =
        request.method === 'POST'
          ? answers.shift()!
          : { status: 200, headers: { 'content-type': 'text/html' }, body: PAGE };
      response.writeHead(answer.status, answer.headers ?? {});
      response.end(answer.body ?? '');
    });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/wallet`);
    await run();
  } finally {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  }
}

/** The first submission, as the portal's client sends a fetch action. */
async function firstSubmission(page: Page): Promise<Request> {
  const sent = page.waitForRequest((entry) => entry.method() === 'POST');
  await page.getByRole('button', { name: 'top up' }).click();
  return sent;
}

test.describe('the action success oracle', () => {
  test('a submission and its replay that both succeed pass, and the replay is the same action', async ({
    page,
  }) => {
    await portal(page, [success(), success()], async () => {
      const first = await firstSubmission(page);
      await expectActionSucceeded(first, WALLET);
      const [replay] = await postFromPage(page.locator('body'), [{ resend: first }]);
      expect(replay!.headers()['next-action']).toBe('a1b2');
      expect(replay!.postData()).toBe('amountMinor=73000');
      await expectActionSucceeded(replay!, WALLET);
    });
  });

  const refusals: Array<[string, Answer]> = [
    ...[400, 401, 403, 404, 409, 411, 413, 429, 500, 502].map(
      (status) => [`HTTP ${status}`, { status, body: '' }] as [string, Answer],
    ),
    [
      "the action's refusal as its result, HTTP 200",
      {
        status: 200,
        headers: { 'content-type': 'text/x-component' },
        body: '1:{"kind":"REFUSED","reason":"CSRF"}\n',
      },
    ],
    [
      'an unconfirmed outcome as its result, HTTP 200',
      {
        status: 200,
        headers: { 'content-type': 'text/x-component' },
        body: '1:{"kind":"UNCONFIRMED"}\n',
      },
    ],
    ['a 303 that names no target', { status: 303, body: '' }],
    // A target on any other status is not a redirect the client router follows.
    [
      'a 200 that names the target',
      { status: 200, headers: { 'x-action-redirect': '/wallet;push' } },
    ],
    [
      'a 303 to the login page',
      { status: 303, headers: { 'x-action-redirect': '/login?returnTo=/wallet;replace' } },
    ],
  ];
  for (const [what, answer] of refusals) {
    test(`a replay answered with ${what} fails it`, async ({ page }) => {
      await portal(page, [success(), answer], async () => {
        const first = await firstSubmission(page);
        await expectActionSucceeded(first, WALLET);
        const [replay] = await postFromPage(page.locator('body'), [{ resend: first }]);
        await expect(expectActionSucceeded(replay!, WALLET)).rejects.toThrow();
      });
    });
  }

  test('native posts: both must name the created record; one refused fails it', async ({
    page,
  }) => {
    const created = (id: string): Answer => ({
      status: 303,
      headers: { location: `/usage?created=${id}` },
    });
    await portal(page, [created('USG_1'), { status: 200, body: '<p>refused</p>' }], async () => {
      const sent = await postFromPage(page.locator('form'), [
        { form: 'native' },
        { form: 'native' },
      ]);
      const outcomes = await Promise.allSettled(
        sent.map((entry) =>
          expectActionSucceeded(entry, { path: '/usage', query: { created: /^USG_/ } }),
        ),
      );
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
      const fulfilled = outcomes.find((outcome) => outcome.status === 'fulfilled');
      expect((fulfilled as PromiseFulfilledResult<URLSearchParams>).value.get('created')).toBe(
        'USG_1',
      );
    });
  });

  test('a native post redirected to the page without the created record fails it', async ({
    page,
  }) => {
    await portal(page, [{ status: 303, headers: { location: '/usage?created=' } }], async () => {
      const [sent] = await postFromPage(page.locator('form'), [{ form: 'native' }]);
      await expect(
        expectActionSucceeded(sent!, { path: '/usage', query: { created: /^USG_/ } }),
      ).rejects.toThrow();
    });
  });
});
