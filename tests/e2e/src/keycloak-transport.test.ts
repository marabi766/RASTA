import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { inspect } from 'node:util';
import { e2eConfig, type E2eConfig } from './env.ts';
import { AnswerError, failureMessage, TransportError, type Fetch } from './http.ts';
import { freshToken } from './keycloak-accounts.ts';
import { accessToken } from './keycloak.ts';
import { adminRequest, claimsOf, forgetAdminToken } from './keycloak-transport.ts';

/**
 * Every Keycloak call fails with fixed text (Codex r6 on #241): a `KEYCLOAK_URL` with userinfo,
 * a token response that is not JSON, a refusal that quotes the request back, an admin grant
 * that answers garbage — none of it reaches an error. And a grant that never answers is cut
 * off at the request timeout. Runs under `node --test`, without a stack.
 */

/** Distinctive enough that finding it anywhere means a credential got out. */
const CANARY = 'KCLEAKCANARY4e81';
const PASSWORD = `pw-${CANARY}`;

/** Everything a reporter can print about an error: message, stack, cause chain, own fields. */
function everything(error: unknown): string {
  return `${String(error)}\n${(error as Error)?.stack ?? ''}\n${inspect(error, { depth: 10 })}`;
}

function assertNoCredential(error: unknown): void {
  const text = everything(error);
  assert.ok(!text.includes(CANARY), `a credential leaked:\n${text}`);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => assert.fail('must throw'),
    (thrown: unknown) => thrown,
  );
}

/** A transport that answers every request with this status and body. */
function answering(status: number, body: string, seen: RequestInit[] = []): Fetch {
  return (_url, init) => {
    seen.push(init);
    return Promise.resolve(new Response(body, { status }));
  };
}

let config: E2eConfig;

before(() => {
  // The seed users' password, without reading the realm file.
  process.env.E2E_USER_PASSWORD = PASSWORD;
  config = {
    ...e2eConfig(),
    keycloakUrl: 'http://127.0.0.1:8080',
    keycloakAdmin: { username: 'admin', password: PASSWORD },
  };
});

afterEach(() => forgetAdminToken());

describe('M1: a KEYCLOAK_URL with userinfo', () => {
  it('fails at the transport with fixed text, quoting neither the password nor the URL', async () => {
    const error = await rejection(
      freshToken('provisioned.user', {
        ...config,
        keycloakUrl: `http://kc-admin:${PASSWORD}@127.0.0.1:8080`,
      }),
    );

    assert.ok(error instanceof TransportError, everything(error));
    assert.match(
      error.message,
      /^Transport failure: POST \/realms\/rasta\/protocol\/openid-connect\/token \(status none, cause [A-Z_]+\)$/,
    );
    assert.equal(error.cause, undefined);
    assertNoCredential(error);
    assert.ok(!everything(error).includes('kc-admin'));
  });
});

describe('M1: a token response that is not what it should be', () => {
  it('a body that is not JSON fails with fixed text, not the parser’s quote of it', async () => {
    // A truncated grant answer: JSON.parse would quote the start of the token.
    const truncated = `{"access_token":"eyJhbGciOiJSUzI1NiJ9.${CANARY}`;
    const seen: RequestInit[] = [];
    const error = await rejection(
      accessToken('dehyari.admin', config, { fetch: answering(200, truncated, seen) }),
    );

    // Not vacuous: the grant did carry the password, form-encoded.
    assert.match(String(seen[0]?.body), new RegExp(`password=${PASSWORD}`));
    assert.ok(error instanceof AnswerError);
    assert.equal(
      error.message,
      'Keycloak sent an unreadable token response for dehyari.admin: ' +
        'POST /realms/rasta/protocol/openid-connect/token answered 2xx (body not JSON)',
    );
    assertNoCredential(error);
  });

  it('JSON without an access_token fails with fixed text', async () => {
    const error = await rejection(
      freshToken('provisioned.user', config, {
        fetch: answering(200, JSON.stringify({ token: CANARY })),
      }),
    );

    assert.ok(error instanceof AnswerError);
    assert.match(error.message, /answered 2xx \(no access_token\)$/);
    assertNoCredential(error);
  });

  it('a refusal names the status class and the OAuth error code, never the body', async () => {
    const error = await rejection(
      freshToken('provisioned.user', config, {
        fetch: answering(
          401,
          JSON.stringify({
            error: 'invalid_grant',
            error_description: `Invalid user credentials for password ${PASSWORD}`,
          }),
        ),
      }),
    );

    assert.ok(error instanceof AnswerError);
    assert.equal(
      error.message,
      'Keycloak refused a token for provisioned.user: ' +
        'POST /realms/rasta/protocol/openid-connect/token answered 4xx (error invalid_grant)',
    );
    assertNoCredential(error);
    // What a poll would report: the same fixed text.
    assert.equal(failureMessage(error), error.message);
  });

  it('an error code that is not an identifier is left out', async () => {
    const error = await rejection(
      freshToken('provisioned.user', config, {
        fetch: answering(400, JSON.stringify({ error: `bad ${CANARY}` })),
      }),
    );

    assert.ok(error instanceof AnswerError);
    assert.match(error.message, /answered 4xx$/);
    assertNoCredential(error);
  });

  it('a token whose claims are not JSON is reported without them', () => {
    const error = (() => {
      try {
        claimsOf(
          `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(`{"sub":"${CANARY}`).toString('base64url')}.sig`,
        );
      } catch (thrown) {
        return thrown;
      }
      return assert.fail('must throw');
    })();

    assert.equal((error as Error).message, 'The access token’s claims are not JSON');
    assertNoCredential(error);
  });
});

describe('M1: the admin API', () => {
  it('an admin grant that answers garbage fails with fixed text', async () => {
    const error = await rejection(
      adminRequest(config, 'GET', '/users?username=x', undefined, {
        fetch: answering(200, `<html>${CANARY}</html>`),
      }),
    );

    assert.ok(error instanceof AnswerError);
    assert.equal(
      error.message,
      'Keycloak sent an unreadable token response for the administrator ' +
        '(KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD): ' +
        'POST /realms/master/protocol/openid-connect/token answered 2xx (body not JSON)',
    );
    assertNoCredential(error);
  });

  it('an admin call refused names the call without its query or the answer', async () => {
    const adminToken = `eyJhbGciOiJSUzI1NiJ9.e30.${CANARY}`;
    const seen: RequestInit[] = [];
    const fetchImpl: Fetch = (url, init) => {
      seen.push(init);
      return Promise.resolve(
        url.endsWith('/protocol/openid-connect/token')
          ? new Response(JSON.stringify({ access_token: adminToken, expires_in: 60 }))
          : new Response(JSON.stringify({ errorMessage: `echo: ${adminToken}` }), { status: 403 }),
      );
    };
    const error = await rejection(
      adminRequest(config, 'GET', `/users?username=${CANARY}&exact=true`, undefined, {
        fetch: fetchImpl,
      }),
    );

    assert.equal(
      (seen[1]?.headers as Record<string, string>).authorization,
      `Bearer ${adminToken}`,
    );
    assert.ok(error instanceof AnswerError);
    assert.equal(
      error.message,
      'Keycloak admin call failed: GET /admin/realms/rasta/users answered 4xx',
    );
    assertNoCredential(error);
  });
});

describe('M2: a token grant that never answers', () => {
  it('is cut off at the request timeout, even by a transport that ignores the abort', async () => {
    const stalled: Fetch = () => new Promise<Response>(() => undefined);
    const started = Date.now();
    const error = await rejection(
      freshToken('provisioned.user', config, { fetch: stalled, timeoutMs: 50 }),
    );

    assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started}ms`);
    assert.ok(error instanceof TransportError);
    assert.equal(
      error.message,
      'Transport failure: POST /realms/rasta/protocol/openid-connect/token (status none, cause TIMEOUT)',
    );
  });

  it('is aborted at the request timeout by a transport that honours the signal', async () => {
    const honouring: Fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const error = await rejection(
      accessToken('dehyari.admin', config, { fetch: honouring, timeoutMs: 50 }),
    );

    assert.ok(error instanceof TransportError);
    assert.equal(error.causeCode, 'TIMEOUT');
  });
});
