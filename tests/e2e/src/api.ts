import { test as base, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { e2eConfig, type E2eConfig } from './env';
import { accessToken, E2E_USERS, type E2eUser } from './keycloak';

/**
 * The client every scenario drives the platform through.
 *
 * Playwright's `APIRequestContext` rather than a browser, because there is no
 * production frontend yet: `apps/web` is an empty directory (PROJECT_MEMORY
 * § 6). Writing a browser test against a page that does not exist would mean
 * building a page for the test to click, and then the suite would prove that
 * the fixture works. An API-level run through the gateway exercises the whole
 * stack that *does* exist — gateway routing, rate limiting, idempotency
 * enforcement, JWT verification, tenant resolution, the domain, PostgreSQL and
 * Kafka — and none of it is mocked.
 *
 * When `apps/web` lands, a browser project is added to `playwright.config.ts`
 * beside this one; nothing here has to change, because nothing here assumes the
 * absence of a UI.
 */

export interface ApiResponse<T> {
  status: number;
  body: T;
  headers: Record<string, string>;
  /** The correlation id this request carried, for asserting the event path. */
  correlationId: string;
}

export interface CallOptions {
  /** Sent as `Idempotency-Key`. Required by the gateway on economic writes. */
  idempotencyKey?: string;
  /** Sent as `X-Correlation-Id`. Generated when absent so every call has one. */
  correlationId?: string;
  /** Sent as `X-Organization-Id` — the tenant the caller asks to act for. */
  organizationId?: string;
  body?: unknown;
  /**
   * Talk to something other than the gateway.
   *
   * Used in exactly one place — the per-journal ledger read, which the gateway
   * currently makes unreachable for every role (docs/24 Q-27) — and labelled at
   * the call site. Everything else in this suite goes through the front door,
   * because the gateway's routing, rate limiting and idempotency enforcement
   * are part of what is under test.
   */
  baseUrl?: string;
}

/**
 * One authenticated actor, talking to the platform the way a client would.
 *
 * Deliberately thin: it adds headers and parses JSON, and does nothing that
 * could paper over a difference between what the platform returned and what a
 * test asserts.
 */
export class Actor {
  constructor(
    readonly username: E2eUser,
    private readonly context: APIRequestContext,
    private readonly token: string,
    private readonly config: E2eConfig,
  ) {}

  get(path: string, options: CallOptions = {}): Promise<ApiResponse<unknown>> {
    return this.call('GET', path, options);
  }

  post(path: string, options: CallOptions = {}): Promise<ApiResponse<unknown>> {
    return this.call('POST', path, options);
  }

  patch(path: string, options: CallOptions = {}): Promise<ApiResponse<unknown>> {
    return this.call('PATCH', path, options);
  }

  async call(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: CallOptions = {},
  ): Promise<ApiResponse<unknown>> {
    const correlationId = options.correlationId ?? `e2e-${randomUUID()}`;

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      'x-correlation-id': correlationId,
      accept: 'application/json',
    };
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    if (options.organizationId) headers['x-organization-id'] = options.organizationId;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await this.context.fetch(
      `${options.baseUrl ?? this.config.gatewayUrl}${path}`,
      {
        method,
        headers,
        ...(options.body !== undefined ? { data: options.body } : {}),
        // These tests assert on 4xx as much as on 2xx, so a non-2xx is data, not
        // a transport failure.
        failOnStatusCode: false,
      },
    );

    const text = await response.text();
    let body: unknown = text;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        // Left as text. A non-JSON body from a JSON API is itself a finding,
        // and swallowing it into `{}` would hide it.
      }
    }

    return { status: response.status(), body, headers: response.headers(), correlationId };
  }
}

/** An unauthenticated caller — used to prove endpoints are closed by default. */
export class Anonymous {
  constructor(
    private readonly context: APIRequestContext,
    private readonly config: E2eConfig,
  ) {}

  async get(path: string): Promise<ApiResponse<unknown>> {
    const correlationId = `e2e-${randomUUID()}`;
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
 * from a password-spraying client. Tokens live 15 minutes; a worker's run is
 * shorter than that.
 */
const tokenCache = new Map<string, Promise<string>>();

function cachedToken(username: E2eUser, config: E2eConfig): Promise<string> {
  const existing = tokenCache.get(username);
  if (existing) return existing;
  const pending = accessToken(username, config);
  tokenCache.set(username, pending);
  return pending;
}

async function actor(
  username: E2eUser,
  context: APIRequestContext,
  config: E2eConfig,
): Promise<Actor> {
  return new Actor(username, context, await cachedToken(username, config), config);
}

export const test = base.extend<RastaFixtures>({
  // Playwright determines a fixture's dependencies by reading the destructuring
  // pattern of its first parameter, so a fixture that needs none must still
  // destructure — an empty pattern is the API, not an oversight.
  // eslint-disable-next-line no-empty-pattern
  config: async ({}, use) => {
    await use(e2eConfig());
  },
  tenantA: async ({ request, config }, use) => {
    await use(await actor(E2E_USERS.tenantA, request, config));
  },
  tenantB: async ({ request, config }, use) => {
    await use(await actor(E2E_USERS.tenantB, request, config));
  },
  platformAdmin: async ({ request, config }, use) => {
    await use(await actor(E2E_USERS.platformAdmin, request, config));
  },
  auditor: async ({ request, config }, use) => {
    await use(await actor(E2E_USERS.auditor, request, config));
  },
  anonymous: async ({ request, config }, use) => {
    await use(new Anonymous(request, config));
  },
});

export { expect } from '@playwright/test';

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
