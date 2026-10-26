import { test as base, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Actor, SessionToken, type ApiResponse } from './actor';
import { e2eConfig, type E2eConfig } from './env';
import { accessToken, E2E_USERS, type E2eUser } from './keycloak';

/**
 * The fixtures every scenario drives the platform through.
 *
 * API calls rather than a browser, because there is no production frontend
 * yet: `apps/web` is an empty directory (PROJECT_MEMORY § 6). Writing a browser
 * test against a page that does not exist would mean building a page for the
 * test to click, and then the suite would prove that the fixture works. An
 * API-level run through the gateway exercises the whole stack that *does* exist
 * — gateway routing, rate limiting, idempotency enforcement, JWT verification,
 * tenant resolution, the domain, PostgreSQL and Kafka — and none of it is
 * mocked.
 *
 * An authenticated call goes through `Actor` (`actor.ts`) over Node's `fetch`,
 * never through Playwright's `APIRequestContext`: the runner records a failed
 * API call's request headers in its report, the bearer token among them
 * (`http.ts`). Only `Anonymous`, which carries no credential, uses Playwright's.
 *
 * When `apps/web` lands, a browser project is added to `playwright.config.ts`
 * beside this one; nothing here has to change, because nothing here assumes the
 * absence of a UI.
 */

export {
  Actor,
  failOnUnauthenticated,
  POLL_INTERVAL_MS,
  SessionToken,
  UnauthenticatedError,
  until,
  type ApiResponse,
  type CallOptions,
} from './actor';
export { TransportError } from './http';

/** An unauthenticated caller — used to prove endpoints are closed by default. */
export class Anonymous {
  constructor(
    private readonly context: APIRequestContext,
    private readonly config: E2eConfig,
  ) {}

  async get(path: string): Promise<ApiResponse<unknown>> {
    const correlationId = randomUUID();
    const response = await this.context.fetch(`${this.config.gatewayUrl}${path}`, {
      headers: { 'x-correlation-id': correlationId, accept: 'application/json' },
      failOnStatusCode: false,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      /* left as text */
    }
    return { status: response.status(), body, headers: response.headers(), correlationId };
  }
}

export interface RastaFixtures {
  config: E2eConfig;
  /** Platform operator — the only actor that may read audit evidence across tenants. */
  systemAdmin: Actor;
  /** Tenant A's financial administrator — the payer. */
  tenantA: Actor;
  /** Tenant B's financial administrator — the payee, and the cross-tenant probe. */
  tenantB: Actor;
  /** Platform scope — reads the trial balance and any journal. */
  platformAdmin: Actor;
  /** Province oversight — must reach nothing here. */
  auditor: Actor;
  anonymous: Anonymous;
}

/**
 * A token per worker rather than per test.
 *
 * Keycloak's brute-force protection is on in this realm, and a suite that
 * requests a fresh token for every one of its assertions is indistinguishable
 * from a password-spraying client. Tokens live 15 minutes, and a worker's run
 * can be longer, so the cached token renews itself shortly before it expires
 * (`SessionToken`) — one grant per user per lifetime, not one per test.
 */
const tokenCache = new Map<string, Promise<SessionToken>>();

function cachedToken(username: E2eUser, config: E2eConfig): Promise<SessionToken> {
  const existing = tokenCache.get(username);
  if (existing) return existing;
  const grant = () => accessToken(username, config);
  const pending = grant().then((token) => new SessionToken(token, grant));
  tokenCache.set(username, pending);
  return pending;
}

async function actor(username: E2eUser, config: E2eConfig): Promise<Actor> {
  return new Actor(username, await cachedToken(username, config), config);
}

export const test = base.extend<RastaFixtures>({
  // Playwright determines a fixture's dependencies by reading the destructuring
  // pattern of its first parameter, so a fixture that needs none must still
  // destructure — an empty pattern is the API, not an oversight.
  // eslint-disable-next-line no-empty-pattern
  config: async ({}, use) => {
    await use(e2eConfig());
  },
  systemAdmin: async ({ config }, use) => {
    await use(await actor(E2E_USERS.systemAdmin, config));
  },
  tenantA: async ({ config }, use) => {
    await use(await actor(E2E_USERS.tenantA, config));
  },
  tenantB: async ({ config }, use) => {
    await use(await actor(E2E_USERS.tenantB, config));
  },
  platformAdmin: async ({ config }, use) => {
    await use(await actor(E2E_USERS.platformAdmin, config));
  },
  auditor: async ({ config }, use) => {
    await use(await actor(E2E_USERS.auditor, config));
  },
  anonymous: async ({ request, config }, use) => {
    await use(new Anonymous(request, config));
  },
});

export { expect } from './expect';

/** A key that cannot collide with another run's. */
export function idempotencyKey(label: string): string {
  return `e2e-${label}-${randomUUID()}`;
}

/**
 * The platform error code out of a failed response.
 *
 * The shape is flat — `{ code, message, correlationId, timestamp, path }` from
 * the shared exception filter — and asserting on the code rather than on the
 * status alone is what distinguishes "refused because the tenant does not
 * match" from "refused because the role does not".
 */
export function errorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Parses a minor-unit amount string into the bigint it represents (ADR-022). */
export function minor(value: unknown): bigint {
  if (typeof value !== 'string') {
    throw new Error(`Expected a minor-unit amount as a string, received ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}
