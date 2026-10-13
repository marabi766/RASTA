import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import { Actor, SessionToken, until } from './actor.ts';
import { failureMessage, TransportError, type Fetch } from './http.ts';

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
