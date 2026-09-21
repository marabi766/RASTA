import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type KeyLike } from 'jose';
import { z } from 'zod';

/**
 * The four OIDC steps this portal needs, on the server (ADR-059 § 2).
 *
 * Written against `fetch` and `jose` rather than pulling in an OIDC client
 * library. The flow here is narrow — build an authorization URL with PKCE,
 * exchange the code, verify the id token, refresh — and each step is a few
 * lines with a test. `jose` is already what the gateway verifies tokens with,
 * so nothing new enters the repository's dependency surface.
 *
 * ## PKCE is used even though the client is public and confidential clients
 * exist
 *
 * `rasta-web` is a public client in the development realm because it was
 * provisioned for a browser flow. PKCE is what makes an authorization code
 * useless to anybody who intercepts it: the code can only be exchanged by
 * whoever holds the verifier, and the verifier never leaves this process.
 */

/** The endpoints, derived from the issuer the way Keycloak lays them out. */
export interface OidcEndpoints {
  readonly authorization: string;
  readonly token: string;
  readonly jwks: string;
  readonly endSession: string;
}

export function endpointsFor(issuer: string): OidcEndpoints {
  const base = issuer.replace(/\/+$/, '');
  return {
    authorization: `${base}/protocol/openid-connect/auth`,
    token: `${base}/protocol/openid-connect/token`,
    jwks: `${base}/protocol/openid-connect/certs`,
    endSession: `${base}/protocol/openid-connect/logout`,
  };
}

/** One login attempt, held in a short-lived cookie until the callback returns. */
export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

/**
 * A verifier and its challenge.
 *
 * `S256` only. The `plain` method is still in the specification and is worth
 * nothing: it sends the verifier itself, which is the one thing PKCE exists to
 * keep off the wire.
 */
export function newPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface AuthorizationRequest {
  readonly endpoints: OidcEndpoints;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly challenge: string;
}

/**
 * The URL the browser is redirected to.
 *
 * `state` and `nonce` are separate and both required: `state` ties the
 * callback to the request this server started, and `nonce` ties the id token
 * to it. A flow that reuses one value for both is a flow where a replayed
 * token passes the check that was supposed to catch it.
 */
export function authorizationUrl(request: AuthorizationRequest): string {
  const url = new URL(request.endpoints.authorization);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', request.state);
  url.searchParams.set('nonce', request.nonce);
  url.searchParams.set('code_challenge', request.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** What Keycloak returns from the token endpoint, reduced to what is used. */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export class OidcError extends Error {
  constructor(
    readonly reason: 'TOKEN_REQUEST_FAILED' | 'MALFORMED_RESPONSE' | 'ID_TOKEN_REJECTED',
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'OidcError';
  }
}

async function postForm(
  endpoint: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
      cache: 'no-store',
    });
  } catch {
    // The error object is not forwarded: it can carry the request body, and
    // the request body is a refresh token or an authorization code.
    throw new OidcError('TOKEN_REQUEST_FAILED', 'the identity provider did not answer');
  }

  if (!response.ok) {
    // The status, and nothing from the body. Keycloak's error bodies are
    // useful in a log and are also where a token can end up echoed back.
    throw new OidcError(
      'TOKEN_REQUEST_FAILED',
      `the identity provider answered ${response.status}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OidcError('MALFORMED_RESPONSE', 'the token response was not JSON');
  }

  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new OidcError(
      'MALFORMED_RESPONSE',
      `the token response is missing ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  return parsed.data;
}

export interface ExchangeRequest {
  readonly endpoints: OidcEndpoints;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly verifier: string;
}

export function exchangeCode(
  request: ExchangeRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  return postForm(
    request.endpoints.token,
    {
      grant_type: 'authorization_code',
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      code: request.code,
      code_verifier: request.verifier,
    },
    fetchImpl,
  );
}

export function refreshTokens(
  request: { endpoints: OidcEndpoints; clientId: string; refreshToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  return postForm(
    request.endpoints.token,
    {
      grant_type: 'refresh_token',
      client_id: request.clientId,
      refresh_token: request.refreshToken,
    },
    fetchImpl,
  );
}

/** What the id token is trusted to tell this portal, and nothing beyond it. */
const idTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  nonce: z.string().min(1),
  preferred_username: z.string().min(1).optional(),
  email: z.string().optional(),
  org_id: z.string().optional(),
});

export interface VerifiedIdentity {
  readonly subject: string;
  readonly username: string;
  readonly organizationId: string | null;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, set);
  }
  return set;
}

/**
 * Verifies the id token and binds it to this login attempt.
 *
 * The signature is checked even though the token arrived over TLS from a
 * direct server-to-server call, and the reason is the nonce rather than the
 * transport: without verifying, the nonce is just a string in an unverified
 * blob, and the replay check it exists for proves nothing.
 *
 * The issuer and audience are checked too, so a token minted by a different
 * realm — or for a different client — cannot open a session here.
 */
export async function verifyIdToken(
  idToken: string,
  expectations: { issuer: string; clientId: string; jwksUri: string; nonce: string },
  /**
   * The key material, defaulting to the realm's published JWKS.
   *
   * A seam, and a narrow one: the tests sign a token with a key they hold so
   * they can exercise the nonce, issuer and audience checks without a network
   * call. Production passes nothing and gets the remote key set.
   */
  keys: JWTVerifyGetKey | KeyLike | Uint8Array = jwksFor(expectations.jwksUri),
): Promise<VerifiedIdentity> {
  let claims: unknown;
  const options = {
    issuer: expectations.issuer.replace(/\/+$/, ''),
    audience: expectations.clientId,
  };
  try {
    // Branching rather than passing the union: `jwtVerify` is overloaded on
    // "a key" against "a function that finds one", and a union of the two
    // satisfies neither signature.
    const verified =
      typeof keys === 'function'
        ? await jwtVerify(idToken, keys, options)
        : await jwtVerify(idToken, keys, options);
    claims = verified.payload;
  } catch {
    throw new OidcError('ID_TOKEN_REJECTED', 'signature, issuer or audience did not verify');
  }

  const parsed = idTokenClaimsSchema.safeParse(claims);
  if (!parsed.success) {
    throw new OidcError('ID_TOKEN_REJECTED', 'the id token is missing a required claim');
  }
  if (parsed.data.nonce !== expectations.nonce) {
    // A token that verifies but answers a different login attempt is a replay.
    throw new OidcError('ID_TOKEN_REJECTED', 'the nonce does not match this login attempt');
  }

  return {
    subject: parsed.data.sub,
    username: parsed.data.preferred_username ?? parsed.data.email ?? parsed.data.sub,
    organizationId: parsed.data.org_id ?? null,
  };
}

/** A fresh opaque value for `state` or `nonce`. */
export function newOpaqueValue(): string {
  return randomBytes(32).toString('base64url');
}
