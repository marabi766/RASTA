import type { E2eConfig } from './env';
import {
  AnswerError,
  answerCodeOf,
  jsonOf,
  send,
  type Fetch,
  type HttpAnswer,
  type HttpMethod,
} from './http.ts';

/**
 * Every request this suite sends Keycloak, through the transport `Actor` uses (Codex r6 on
 * #241): `send`, over Node's `fetch`, bounded by its timeout.
 *
 * Each one carries a credential — a password in a grant, the admin token, a user's bearer
 * token — so each one fails the way an `Actor` call does: a `TransportError` when there is no
 * answer, and an `AnswerError` when the answer is a refusal or unreadable. Both are fixed
 * text: the call (method and path, never the query or the origin), the status class and at
 * most an identifier-shaped code. Never a response body, never a parser's or `fetch`'s own
 * message — `JSON.parse` quotes its input, and a URL with userinfo is quoted whole by the
 * `Request` it cannot build (`target-guard.ts` refuses one at startup as well).
 *
 * No extensionless runtime imports, so `node --test` loads it (`keycloak-transport.test.ts`).
 */

/** Injectable for the tests: a `fetch` that fails on purpose, a shorter timeout. */
export interface KeycloakTransport {
  fetch?: Fetch;
  timeoutMs?: number;
}

type Target = Pick<E2eConfig, 'keycloakUrl'>;

export interface KeycloakRequest {
  method: HttpMethod;
  path: string;
  headers?: Record<string, string>;
  /** Form-encoded, as a token grant is. */
  form?: Record<string, string>;
  /** JSON, as the admin API takes it. */
  body?: unknown;
}

/** One request to Keycloak, whatever it answers; only a missing answer throws. */
export function keycloakRequest(
  config: Target,
  request: KeycloakRequest,
  transport: KeycloakTransport = {},
): Promise<HttpAnswer> {
  return send(
    {
      method: request.method,
      baseUrl: config.keycloakUrl,
      path: request.path,
      headers: {
        accept: 'application/json',
        ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...request.headers,
      },
      body: request.body,
      form: request.form,
    },
    transport.fetch,
    transport.timeoutMs,
  );
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

export interface PasswordGrant {
  realm: string;
  clientId: string;
  username: string;
  password: string;
  scope?: string;
}

/**
 * The resource-owner password grant. `who` names the account in the error — a username or
 * the setting it comes from, never the password.
 */
export async function passwordGrant(
  config: Target,
  grant: PasswordGrant,
  who: string,
  transport?: KeycloakTransport,
): Promise<{ accessToken: string; expiresInSeconds: number | undefined }> {
  const request: KeycloakRequest = {
    method: 'POST',
    path: `/realms/${grant.realm}/protocol/openid-connect/token`,
    form: {
      grant_type: 'password',
      client_id: grant.clientId,
      username: grant.username,
      password: grant.password,
      ...(grant.scope ? { scope: grant.scope } : {}),
    },
  };
  const answer = await keycloakRequest(config, request, transport);
  if (!ok(answer.status)) {
    throw new AnswerError(
      `Keycloak refused a token for ${who}`,
      request,
      answer.status,
      answerCodeOf(answer.text),
    );
  }
  const unreadable = `Keycloak sent an unreadable token response for ${who}`;
  const body = jsonOf<{ access_token?: unknown; expires_in?: unknown } | null>(
    unreadable,
    request,
    answer,
  );
  const accessToken = body?.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new AnswerError(unreadable, request, answer.status, 'no access_token');
  }
  return {
    accessToken,
    expiresInSeconds: typeof body?.expires_in === 'number' ? body.expires_in : undefined,
  };
}

type AdminTarget = Pick<E2eConfig, 'keycloakUrl' | 'realm' | 'keycloakAdmin'>;

/** Renewed this long before Keycloak says it expires. */
const ADMIN_TOKEN_MARGIN_MS = 10_000;
/** When Keycloak does not say: the shortest lifetime it issues by default. */
const ADMIN_TOKEN_FALLBACK_SECONDS = 60;

let adminToken: { value: string; expiresAt: number } | undefined;

async function adminAccessToken(
  config: AdminTarget,
  transport?: KeycloakTransport,
): Promise<string> {
  if (adminToken && adminToken.expiresAt > Date.now() + ADMIN_TOKEN_MARGIN_MS) {
    return adminToken.value;
  }
  const granted = await passwordGrant(
    config,
    {
      realm: 'master',
      clientId: 'admin-cli',
      username: config.keycloakAdmin.username,
      password: config.keycloakAdmin.password,
    },
    'the administrator (KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD)',
    transport,
  );
  adminToken = {
    value: granted.accessToken,
    expiresAt: Date.now() + (granted.expiresInSeconds ?? ADMIN_TOKEN_FALLBACK_SECONDS) * 1000,
  };
  return adminToken.value;
}

/** Forgets the cached admin token: for the tests, which grant against fakes. */
export function forgetAdminToken(): void {
  adminToken = undefined;
}

/**
 * One admin API call on the realm under test (`/admin/realms/<realm><path>`), as the
 * administrator. Anything but a 2xx throws an `AnswerError`.
 */
export async function adminRequest(
  config: AdminTarget,
  method: HttpMethod,
  path: string,
  body?: unknown,
  transport?: KeycloakTransport,
): Promise<HttpAnswer> {
  const request: KeycloakRequest = {
    method,
    path: `/admin/realms/${config.realm}${path}`,
    headers: { authorization: `Bearer ${await adminAccessToken(config, transport)}` },
    body,
  };
  const answer = await keycloakRequest(config, request, transport);
  if (!ok(answer.status)) {
    throw new AnswerError(
      'Keycloak admin call failed',
      request,
      answer.status,
      answerCodeOf(answer.text),
    );
  }
  return answer;
}

/** An admin GET's body as JSON, or an `AnswerError` saying only that it was not. */
export async function adminRead<T>(
  config: AdminTarget,
  path: string,
  transport?: KeycloakTransport,
): Promise<T> {
  const answer = await adminRequest(config, 'GET', path, undefined, transport);
  return jsonOf<T>(
    'Keycloak admin call answered unreadably',
    { method: 'GET', path: `/admin/realms/${config.realm}${path}` },
    answer,
  );
}

/**
 * A token's claims, read without the token ever reaching an error: a segment that does not
 * decode to JSON fails with fixed text (`JSON.parse` would quote it).
 */
export function claimsOf(token: string): Record<string, unknown> {
  const segment = token.split('.')[1] ?? '';
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new Error('The access token’s claims are not JSON');
  }
  if (typeof claims !== 'object' || claims === null) {
    throw new Error('The access token’s claims are not an object');
  }
  return claims as Record<string, unknown>;
}
