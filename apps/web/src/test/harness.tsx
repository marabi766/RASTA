import { render, type RenderResult } from '@testing-library/react';
import { axe } from 'jest-axe';
import type { ReactElement, ReactNode } from 'react';
import { ApiClient } from '@/lib/api/client';
import { SessionContext, type SessionValue } from '@/lib/auth/session';
import type { TokenClaims } from '@/lib/auth/claims';

/**
 * Test scaffolding.
 *
 * Screens are mounted against a real `ApiClient` wired to a mocked `fetch`,
 * never against a mocked client. That is the difference between testing the
 * marketplace screen and testing a stub: the request the assertion sees is the
 * one the boundary actually built, headers and all.
 */

export const GATEWAY = 'http://localhost:3000';

export const TEST_CLAIMS: TokenClaims = {
  subject: 'kc-subject',
  userId: 'usr_01',
  displayName: 'کاربر آزمایشی',
  roles: ['PROCUREMENT_USER'],
  activeOrganizationId: 'org_one',
  organizationIds: ['org_one', 'org_two'],
  expiresAt: Date.now() + 900_000,
};

export interface Harness {
  readonly fetchMock: jest.Mock;
  readonly session: SessionValue;
}

export function makeHarness(overrides: Partial<SessionValue> = {}): Harness {
  const fetchMock = jest.fn();

  const organizationId = overrides.organizationId ?? 'org_one';
  const claims = overrides.claims === undefined ? TEST_CLAIMS : overrides.claims;

  const api = new ApiClient({
    baseUrl: GATEWAY,
    fetchImpl: fetchMock as unknown as typeof fetch,
    newCorrelationId: () => 'cid-test',
    session: () =>
      claims
        ? {
            accessToken: 'token-test',
            organizationId,
            organizationIds: claims.organizationIds,
          }
        : null,
  });

  const session: SessionValue = {
    status: 'authenticated',
    claims,
    organizationId,
    configurationIssues: [],
    env: {
      apiBaseUrl: GATEWAY,
      keycloakUrl: 'http://localhost:8080',
      keycloakRealm: 'rasta',
      keycloakClientId: 'rasta-web',
    },
    api,
    signIn: jest.fn().mockResolvedValue(undefined),
    signOut: jest.fn().mockResolvedValue(undefined),
    selectOrganization: jest.fn().mockReturnValue(true),
    ...overrides,
  };

  return { fetchMock, session };
}

export function renderWithSession(ui: ReactElement, session: SessionValue): RenderResult {
  const Wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
  );

  return render(ui, { wrapper: Wrapper });
}

/**
 * A `fetch` implementation that answers the same body every time.
 *
 * `mockResolvedValue(new Response(...))` looks equivalent and is not: a
 * `Response` body is a stream that can be read once, so the second call throws
 * "Body is unusable". Building a fresh one per call is what makes a retry test
 * possible at all.
 */
export function respondJson(body: unknown, status = 200): () => Promise<Response> {
  return () => Promise.resolve(jsonResponse(body, status));
}

export function respondError(status: number, code: string): () => Promise<Response> {
  return () => Promise.resolve(errorResponse(status, code));
}

export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'cid-gateway', ...headers },
  });
}

export function errorResponse(status: number, code: string): Response {
  return jsonResponse(
    {
      code,
      message: 'upstream english text',
      correlationId: 'cid-gateway',
      timestamp: new Date().toISOString(),
    },
    status,
  );
}

/**
 * Fails on any axe violation.
 *
 * docs/16 § 16.9 makes `axe-core` in component tests an acceptance criterion,
 * not a suggestion. The message lists the rule ids so a failure names what
 * broke rather than just that something did.
 */
export async function expectNoAxeViolations(container: HTMLElement): Promise<void> {
  const results = await axe(container);

  if (results.violations.length > 0) {
    const summary = results.violations
      .map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} node(s))`)
      .join('\n  ');
    throw new Error(`Accessibility violations found:\n  ${summary}`);
  }
}
