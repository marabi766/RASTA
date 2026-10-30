import { SignJWT } from 'jose';

/**
 * The key a test mints internal tokens with: the same three values a service
 * constructs its `InternalTokenService` from (INTERNAL_TOKEN_SECRET,
 * INTERNAL_TOKEN_ISSUER, INTERNAL_TOKEN_TTL_SECONDS). No defaults: a test names
 * the issuer and lifetime the service under test verifies against.
 */
export interface TestInternalTokenKey {
  readonly secret: string;
  readonly issuer: string;
  readonly ttlSeconds: number;
}

/**
 * An internal service token for a test to present to a service's guard.
 *
 * Production mints only through nest-common's `InternalHttpClient`; test token
 * factories mint here instead of calling `InternalTokenService.issue`, so the
 * production issuer has no test caller (PR #503 r2 prep). The claim layout —
 * header, `iss`/`aud`/`sub`, `svc`, `purpose`, `org_id` only when given,
 * `iat`, `exp` — is the issuer's, held identical by
 * packages/nest-common/src/auth/test-token-parity.spec.ts.
 *
 * This package is a devDependency only (scripts/testing-dev-only.test.mjs),
 * so this signer is absent from every production image.
 */
export async function mintTestInternalToken(
  key: TestInternalTokenKey,
  callerService: string,
  targetService: string,
  purpose: 'SERVICE' | 'RELAY' = 'SERVICE',
  organizationId?: string,
): Promise<string> {
  if (key.secret.length < 32) {
    throw new Error('INTERNAL_TOKEN_SECRET must be at least 32 characters');
  }
  return new SignJWT({
    svc: callerService,
    purpose,
    ...(organizationId ? { org_id: organizationId } : {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(key.issuer)
    .setAudience(targetService)
    .setSubject(callerService)
    .setIssuedAt()
    .setExpirationTime(`${key.ttlSeconds}s`)
    .sign(new TextEncoder().encode(key.secret));
}
