import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import { Actor, SessionToken, until } from './actor.ts';
import { failureMessage, TransportError, type Fetch } from './http.ts';
import { CHECK_STILL_RUNNING, waitFor } from './poll.ts';

/**
 * No credential leaves through a failure (Codex r5 on #241): a request that gets no answer
 * throws a `TransportError` that names the call and never its headers, and a poll's timeout
 * carries only that. Runs under `node --test`, without a stack.
 */

/** Distinctive enough that finding it anywhere means the token got out. */
const CANARY = 'LEAKCANARY7f3a9c';

function syntheticToken(): string {
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${segment({ alg: 'RS256', typ: 'JWT' })}.${segment({ exp: now + 3600, iat: now, sub: 'synthetic' })}.${CANARY}-signature`;
}

const TOKEN = syntheticToken();
const [, TOKEN_CLAIMS = ''] = TOKEN.split('.');
const INTERNAL_TOKEN = `${syntheticToken()}-internal`;

/** Everything a reporter can print about an error: message, stack, cause chain, own fields. */
function everything(error: unknown): string {
  return `${String(error)}\n${(error as Error)?.stack ?? ''}\n${inspect(error, { depth: 10 })}`;
}

function assertNoCredential(text: string): void {
  assert.ok(!text.includes(CANARY), `the token's distinctive part leaked:\n${text}`);
  // The payload segment too: a token cut short is still a token.
  assert.ok(
    TOKEN_CLAIMS.length > 0 && !text.includes(TOKEN_CLAIMS),
    `the token's claims leaked:\n${text}`,
  );
}

/** A loopback port nothing listens on: bound, then closed. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * The worst case, intercepted: a transport that refuses the connection with an error whose
 * message and cause both quote the request's headers — what Playwright's call log did.
 */
function refusingWithHeaders(seen: Record<string, string>[]): Fetch {
  return (_url, init) => {
    const headers = init.headers as Record<string, string>;
    seen.push(headers);
    const quoted = Object.entries(headers)
      .map(([name, value]) => `  - ${name}: ${value}`)
      .join('\n');
    const socket = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:3000\n${quoted}`), {
      code: 'ECONNREFUSED',
    });
    return Promise.reject(new TypeError(`fetch failed\n${quoted}`, { cause: socket }));
  };
}

function actor(fetchImpl?: Fetch, gatewayUrl = 'http://127.0.0.1:3000'): Actor {
  return new Actor(
    'synthetic.user',
    new SessionToken(TOKEN, () => Promise.resolve(TOKEN)),
    { gatewayUrl },
    fetchImpl,
  );
}

describe('a transport failure at the Actor boundary', () => {
  it('an intercepted ECONNREFUSED quoting the headers propagates without the token', async () => {
    const seen: Record<string, string>[] = [];
    const error = await actor(refusingWithHeaders(seen))
      .get('/v1/contracts/CTR-1?view=full')
      .then(
        () => assert.fail('a refused connection must throw'),
        (thrown: unknown) => thrown,
      );

    // Not vacuous: the request did carry the token.
    assert.equal(seen[0]?.authorization, `Bearer ${TOKEN}`);
    assert.ok(error instanceof TransportError);
    assert.equal(
      error.message,
      'Transport failure: GET /v1/contracts/CTR-1 (status none, cause ECONNREFUSED)',
    );
    assert.equal(error.causeCode, 'ECONNREFUSED');
    assert.equal(error.cause, undefined);
    assertNoCredential(everything(error));
  });

  it('a real ECONNREFUSED on a closed loopback port propagates without the token', async () => {
    const port = await closedPort();
    const error = await actor(undefined, `http://127.0.0.1:${port}`)
      .post('/v1/contracts/CTR-1/sign', { body: { version: 1 }, idempotencyKey: 'k' })
      .then(
        () => assert.fail('a closed port must refuse'),
        (thrown: unknown) => thrown,
      );

    assert.ok(error instanceof TransportError);
    assert.equal(
      error.message,
      'Transport failure: POST /v1/contracts/CTR-1/sign (status none, cause ECONNREFUSED)',
    );
    assertNoCredential(everything(error));
  });

  it('an internal token is kept out the same way', async () => {
    const seen: Record<string, string>[] = [];
    const error = await actor(refusingWithHeaders(seen))
      .get('/v1/internal/x', { internalToken: INTERNAL_TOKEN })
      .then(
        () => assert.fail('a refused connection must throw'),
        (thrown: unknown) => thrown,
      );

    assert.equal(seen[0]?.['x-internal-token'], INTERNAL_TOKEN);
    assert.ok(error instanceof TransportError);
    assertNoCredential(everything(error));
  });

  it('a body that cannot be read names the status class and the cause, not the headers', async () => {
    const failing: Fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                Object.assign(new Error(`socket hang up; authorization: Bearer ${TOKEN}`), {
                  code: 'ECONNRESET',
                }),
              );
            },
          }),
          { status: 503 },
        ),
      );
    const error = await actor(failing)
      .get('/v1/contracts')
      .then(
        () => assert.fail('an unreadable body must throw'),
        (thrown: unknown) => thrown,
      );

    assert.ok(error instanceof TransportError);
    assert.equal(
      error.message,
      'Transport failure: GET /v1/contracts (status 5xx, cause ECONNRESET)',
    );
    assertNoCredential(everything(error));
  });
});

describe('until()', () => {
  it('times out naming the sanitized transport failure, never the token', async () => {
    const seen: Record<string, string>[] = [];
    const client = actor(refusingWithHeaders(seen));
    const error = await until(
      'the contract to be signed',
      async () => {
        await client.get('/v1/contracts/CTR-1');
        return undefined;
      },
      50,
      10,
    ).then(
      () => assert.fail('a poll that never succeeds must time out'),
      (thrown: unknown) => thrown,
    );

    assert.ok(seen.length >= 1, 'the poll did call through the actor');
    assert.match(
      (error as Error).message,
      /^Timed out after 50ms waiting for the contract to be signed; Transport failure: GET \/v1\/contracts\/CTR-1 \(status none, cause ECONNREFUSED\)$/,
    );
    assertNoCredential(everything(error));
  });

  it('redacts a credential that some other error put in its message', async () => {
    const error = await until(
      'anything',
      () => Promise.reject(new Error(`unexpected: authorization: Bearer ${TOKEN} and ${TOKEN}`)),
      30,
      10,
    ).then(
      () => assert.fail('must time out'),
      (thrown: unknown) => thrown,
    );

    assert.match((error as Error).message, /Bearer \[redacted\] and \[redacted\]$/);
    assertNoCredential(everything(error));
  });
});

describe('a stalled token grant (Codex r6 on #241)', () => {
  /** A token that is already due for renewal, so the next call asks the grant. */
  function expiredToken(): string {
    const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    return `${segment({ alg: 'RS256' })}.${segment({ exp: now - 10, iat: now - 910 })}.${CANARY}`;
  }
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
  const elapsedSince = (started: number) => Date.now() - started;

  it('until() fails at its declared timeout, not when the grant gives up', async () => {
    const sent: string[] = [];
    const client = new Actor(
      'synthetic.user',
      // The grant's own bound is well after the poll's: only the poll's deadline can end this.
      new SessionToken(expiredToken(), never, 1_500),
      { gatewayUrl: 'http://127.0.0.1:3000' },
      (url) => {
        sent.push(url);
        return Promise.resolve(new Response('{}'));
      },
    );
    const started = Date.now();
    const error = await until(
      'the contract to be signed',
      async () => {
        await client.get('/v1/contracts/CTR-1');
        return undefined;
      },
      100,
      10,
    ).then(
      () => assert.fail('a poll whose every call stalls must time out'),
      (thrown: unknown) => thrown,
    );

    assert.ok(elapsedSince(started) < 1_000, `took ${elapsedSince(started)}ms`);
    assert.equal(sent.length, 0, 'no request is sent while the token is being renewed');
    assert.equal(
      (error as Error).message,
      `Timed out after 100ms waiting for the contract to be signed; ${CHECK_STILL_RUNNING}`,
    );
    assertNoCredential(everything(error));
  });

  it('a renewal is bounded by itself too, with fixed text', async () => {
    const token = new SessionToken(expiredToken(), never, 30);
    const started = Date.now();
    const error = await token.value().then(
      () => assert.fail('a renewal that never answers must fail'),
      (thrown: unknown) => thrown,
    );

    assert.ok(elapsedSince(started) < 1_000, `took ${elapsedSince(started)}ms`);
    assert.equal((error as Error).message, 'The token renewal did not answer within 30ms');
    assertNoCredential(everything(error));
  });

  it('events.waitFor() fails at its declared timeout over a check that never answers', async () => {
    const started = Date.now();
    const error = await waitFor('the tap to join', never, 100, undefined, 10).then(
      () => assert.fail('must time out'),
      (thrown: unknown) => thrown,
    );

    assert.ok(elapsedSince(started) < 1_000, `took ${elapsedSince(started)}ms`);
    assert.equal(
      (error as Error).message,
      `Timed out after 100ms waiting for the tap to join; ${CHECK_STILL_RUNNING}`,
    );
  });

  it('events.waitFor() still reports the last failure, sanitized', async () => {
    const error = await waitFor(
      'anything',
      () => Promise.reject(new Error(`authorization: Bearer ${TOKEN}`)),
      30,
      undefined,
      5,
    ).then(
      () => assert.fail('must time out'),
      (thrown: unknown) => thrown,
    );

    assert.match(
      (error as Error).message,
      /; last error: Error: authorization: Bearer \[redacted\]$/,
    );
    assertNoCredential(everything(error));
  });
});

describe('failureMessage', () => {
  it('is a transport failure’s own fixed text, and a redacted message otherwise', () => {
    const transport = new TransportError({ method: 'PUT', path: '/v1/x?token=1' }, 204, 'EPIPE');
    assert.equal(
      failureMessage(transport),
      'Transport failure: PUT /v1/x (status 2xx, cause EPIPE)',
    );
    assert.equal(failureMessage(`raw ${TOKEN}`), 'raw [redacted]');
  });
});

describe('internal-token redirect rejection', () => {
  for (const status of [301, 302, 303, 307, 308])
    for (const sameOrigin of [false, true])
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        it(`${method} ${status} sameOrigin=${sameOrigin} sends one exchange and never forwards credentials`, async () => {
          let sent = 0;
          const reached: unknown[] = [];
          const target = createHttpServer((req, res) => {
            reached.push(req.headers['x-internal-token']);
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
          });
          await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
          const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
          const source = createHttpServer((req, res) => {
            req.resume();
            if (req.url === '/redirect-target') {
              reached.push(req.headers['x-internal-token']);
              res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
              return;
            }
            sent += 1;
            assert.equal(req.method, method);
            assert.equal(req.headers['x-internal-token'], INTERNAL_TOKEN);
            res
              .writeHead(status, {
                location: sameOrigin ? '/redirect-target' : `${targetUrl}/redirect-target`,
              })
              .end('untrusted');
          });
          await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
          try {
            const baseUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
            const error = await actor(undefined, baseUrl)
              .call(method, '/v1/internal/x', { internalToken: INTERNAL_TOKEN })
              .catch((error: unknown) => error);
            assert.ok(error instanceof TransportError);
            assert.equal(error.causeCode, 'REDIRECT');
            assertNoCredential(everything(error));
            assert.equal(sent, 1);
            assert.deepEqual(reached, []);
          } finally {
            for (const server of [source, target]) {
              server.closeAllConnections();
              await new Promise<void>((resolve) => server.close(() => resolve()));
            }
          }
        });
      }
});
