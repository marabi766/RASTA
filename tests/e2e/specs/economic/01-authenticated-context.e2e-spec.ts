import { test, expect, errorCode } from '../../src/api';
import { ORG } from '../../src/env';

/**
 * Scenario 1 — an authenticated organization context.
 *
 * docs/14 § 14.7 row 1: "ورود · انتخاب سازمان · مشاهده داشبورد". Without a
 * frontend the "dashboard" is the wallet the portal would render, but the
 * substance of the row is the same and is what everything after it depends on:
 * a real token from a real identity provider resolves to exactly one
 * organization, and the platform acts for that one and no other.
 */
test.describe('Authenticated organization context', () => {
  test('an unauthenticated caller is refused — endpoints are closed by default', async ({
    anonymous,
  }) => {
    const response = await anonymous.get('/v1/wallets/me');

    expect(response.status).toBe(401);
    // The gateway echoes the correlation id even on a rejection, which is what
    // makes a user's "I got an error" reportable.
    expect(response.headers['x-correlation-id']).toBe(response.correlationId);
  });

  test('a real Keycloak token resolves to the organization it was issued for', async ({
    tenantA,
  }) => {
    const response = await tenantA.get('/v1/wallets/me');

    expect(response.status).toBe(200);
    const wallet = response.body as { organizationId: string; currency: string; status: string };
    expect(wallet.organizationId).toBe(ORG.a);
    expect(wallet.currency).toBe('IRR');
    expect(wallet.status).toBe('ACTIVE');
  });

  test('the second tenant resolves to its own organization, not the first', async ({ tenantB }) => {
    const response = await tenantB.get('/v1/wallets/me');

    expect(response.status).toBe(200);
    expect((response.body as { organizationId: string }).organizationId).toBe(ORG.b);
  });

  test('asking to act for an organization the token has no membership in is refused', async ({
    tenantA,
  }) => {
    // The `X-Organization-Id` header is a request, never an assertion: the auth
    // guard checks it against the memberships in the verified token. This is
    // the exact point at which a mistake becomes a tenant escape
    // (packages/nest-common auth.guard.ts).
    const response = await tenantA.get('/v1/wallets/me', { organizationId: ORG.b });

    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe('TENANT_MISMATCH');
  });
});
