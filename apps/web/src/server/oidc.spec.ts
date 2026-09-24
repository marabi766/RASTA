/**
 * @jest-environment node
 */
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import {
  OidcError,
  authorizationUrl,
  endpointsFor,
  exchangeCode,
  newPkcePair,
  refreshTokens,
  verifyIdToken,
} from './oidc';

/**
 * The four OIDC steps, and the checks that make each of them worth doing
 * (ADR-059 § 2).
 */

const ISSUER = 'http://keycloak.test/realms/rasta';
const CLIENT = 'rasta-web';
const endpoints = endpointsFor(ISSUER);
const KEY = new TextEncoder().encode('a-test-signing-key-that-is-long-enough');

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; body: string }[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

async function idToken(claims: Record<string, unknown>, overrides: { audience?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(overrides.audience ?? CLIENT)
    .setExpirationTime('5m')
    .sign(KEY);
}

describe('where the endpoints are', () => {
  it('derives them from the issuer and tolerates a trailing slash', () => {
    expect(endpoints.token).toBe(`${ISSUER}/protocol/openid-connect/token`);
    expect(endpointsFor(`${ISSUER}/`).jwks).toBe(endpoints.jwks);
  });
});

describe('PKCE', () => {
  it('derives the challenge as the S256 hash of the verifier', () => {
    // The whole protection: the code is useless without the verifier, and the
    // verifier never leaves this process.
    const { verifier, challenge } = newPkcePair();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(challenge).not.toBe(verifier);
  });

  it('never repeats a verifier', () => {
    expect(newPkcePair().verifier).not.toBe(newPkcePair().verifier);
  });
});

describe('the authorization url', () => {
  const url = new URL(
    authorizationUrl({
      endpoints,
      clientId: CLIENT,
      redirectUri: 'http://localhost:3200/auth/callback',
      state: 'state-value',
      nonce: 'nonce-value',
      challenge: 'challenge-value',
    }),
  );

  it('asks for a code with S256, and for the scopes the portal needs', () => {
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
  });

  it('carries a separate state and nonce', () => {
    // One value for both would mean a replayed token passes the check that
    // exists to catch it.
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('nonce')).toBe('nonce-value');
  });

  it('carries no verifier and no secret', () => {
    expect(url.toString()).not.toContain('code_verifier');
    expect(url.searchParams.get('client_secret')).toBeNull();
  });
});

describe('exchanging the code', () => {
  it('posts the verifier and the grant, and returns the tokens', async () => {
    const { impl, calls } = fakeFetch({
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: 'id',
      expires_in: 300,
      token_type: 'Bearer',
    });

    const tokens = await exchangeCode(
      {
        endpoints,
        clientId: CLIENT,
        redirectUri: 'http://localhost:3200/auth/callback',
        code: 'the-code',
        verifier: 'the-verifier',
      },
      impl,
    );

    expect(tokens.access_token).toBe('access');
    const sent = new URLSearchParams(calls[0]!.body);
    expect(calls[0]!.url).toBe(endpoints.token);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code_verifier')).toBe('the-verifier');
  });

  it('reports a refusal by status alone', async () => {
    // Keycloak's error bodies are useful in a log and are also where a token
    // can end up echoed back, so none of it is carried.
    const { impl } = fakeFetch({ error: 'invalid_grant', code: 'the-code' }, 400);
    await expect(
      exchangeCode(
        { endpoints, clientId: CLIENT, redirectUri: 'http://x/cb', code: 'c', verifier: 'v' },
        impl,
      ),
    ).rejects.toMatchObject({ reason: 'TOKEN_REQUEST_FAILED' });

    await expect(
      exchangeCode(
        { endpoints, clientId: CLIENT, redirectUri: 'http://x/cb', code: 'c', verifier: 'v' },
        impl,
      ),
    ).rejects.not.toThrow(/the-code/);
  });

  it('refuses an answer that is missing a token', async () => {
    const { impl } = fakeFetch({ access_token: 'a', expires_in: 300, token_type: 'Bearer' });
    await expect(
      exchangeCode(
        { endpoints, clientId: CLIENT, redirectUri: 'http://x/cb', code: 'c', verifier: 'v' },
        impl,
      ),
    ).rejects.toMatchObject({ reason: 'MALFORMED_RESPONSE' });
  });

  it('refuses an answer that is not JSON', async () => {
    const { impl } = fakeFetch('<html>a proxy error page</html>');
    await expect(
      exchangeCode(
        { endpoints, clientId: CLIENT, redirectUri: 'http://x/cb', code: 'c', verifier: 'v' },
        impl,
      ),
    ).rejects.toMatchObject({ reason: 'MALFORMED_RESPONSE' });
  });
});

describe('refreshing', () => {
  it('sends the refresh grant', async () => {
    const { impl, calls } = fakeFetch({
      access_token: 'access2',
      refresh_token: 'refresh2',
      id_token: 'id2',
      expires_in: 300,
      token_type: 'Bearer',
    });
    await refreshTokens({ endpoints, clientId: CLIENT, refreshToken: 'old-refresh' }, impl);
    const sent = new URLSearchParams(calls[0]!.body);
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe('old-refresh');
  });
});

describe('verifying the id token', () => {
  const nonce = randomBytes(8).toString('hex');

  it('refuses a token with no expiry, which would otherwise verify forever', async () => {
    // jose checks `exp` only when it is present. Keycloak always sets it, so
    // a token without one did not come from the realm.
    const token = await new SignJWT({ sub: 'USR_1', nonce })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(CLIENT)
      .sign(KEY);

    await expect(
      verifyIdToken(
        token,
        { issuer: ISSUER, clientId: CLIENT, jwksUri: endpoints.jwks, nonce },
        KEY,
      ),
    ).rejects.toMatchObject({ reason: 'ID_TOKEN_REJECTED' });
  });

  it('accepts a token for this client, this realm and this attempt', async () => {
    const token = await idToken({ sub: 'USR_1', nonce, preferred_username: 'dehyar' });
    await expect(
      verifyIdToken(
        token,
        { issuer: ISSUER, clientId: CLIENT, jwksUri: endpoints.jwks, nonce },
        KEY,
      ),
    ).resolves.toEqual({ subject: 'USR_1', username: 'dehyar', organizationId: null });
  });

  it('refuses a token that answers a different login attempt', async () => {
    // Verified, in date, correctly signed — and a replay. The nonce is the
    // only thing that catches it.
    const token = await idToken({ sub: 'USR_1', nonce: 'another-attempt' });
    await expect(
      verifyIdToken(
        token,
        { issuer: ISSUER, clientId: CLIENT, jwksUri: endpoints.jwks, nonce },
        KEY,
      ),
    ).rejects.toBeInstanceOf(OidcError);
  });

  it('refuses a token minted for another client', async () => {
    const token = await idToken({ sub: 'USR_1', nonce }, { audience: 'another-client' });
    await expect(
      verifyIdToken(
        token,
        { issuer: ISSUER, clientId: CLIENT, jwksUri: endpoints.jwks, nonce },
        KEY,
      ),
    ).rejects.toMatchObject({ reason: 'ID_TOKEN_REJECTED' });
  });

  it('refuses a token signed with another key', async () => {
    const token = await idToken({ sub: 'USR_1', nonce });
    const otherKey = new TextEncoder().encode('a-different-key-that-is-long-enough-too');
    await expect(
      verifyIdToken(
        token,
        { issuer: ISSUER, clientId: CLIENT, jwksUri: endpoints.jwks, nonce },
        otherKey,
      ),
    ).rejects.toMatchObject({ reason: 'ID_TOKEN_REJECTED' });
  });

  it('refuses a token with no subject', async () => {
    const token = await idToken({ nonce });
    await expect(
      verifyIdToken(
        token,
        { issuer: ISSUER, clientId: CLIENT, jwksUri: endpoints.jwks, nonce },
        KEY,
      ),
    ).rejects.toMatchObject({ reason: 'ID_TOKEN_REJECTED' });
  });

  it('falls back through the claims that can name a person', async () => {
    const withEmail = await idToken({ sub: 'USR_2', nonce, email: 'someone@example.invalid' });
    await expect(
      verifyIdToken(
        withEmail,
        { issuer: ISSUER, clientId: CLIENT, jwksUri: endpoints.jwks, nonce },
        KEY,
      ),
    ).resolves.toMatchObject({ username: 'someone@example.invalid' });

    const bare = await idToken({ sub: 'USR_3', nonce });
    await expect(
      verifyIdToken(
        bare,
        { issuer: ISSUER, clientId: CLIENT, jwksUri: endpoints.jwks, nonce },
        KEY,
      ),
    ).resolves.toMatchObject({ username: 'USR_3' });
  });
});
