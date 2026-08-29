import { SignJWT } from 'jose';
import { e2eConfig, type E2eConfig } from './env';

/**
 * Internal service tokens, minted the way a calling service mints them.
 *
 * Built here with `jose` rather than imported from `@rasta/nest-common`, and
 * deliberately: this suite talks to a **running** economic-service over HTTP,
 * so what it needs to produce is the wire format, not the platform's helper.
 * Reimplementing the shape is what makes the test able to fail — if the claim
 * names or the algorithm change on the service side, this stops working, which
 * is exactly the signal an end-to-end test exists to give. Importing the
 * issuer would make both sides agree by construction and prove nothing.
 *
 * The organization travels **inside the signature** (ADR-035). An unsigned
 * `X-Organization-Id` is not an authority: the service accepts one only when
 * it agrees with the claim, and refuses the call outright when it does not.
 */

export interface InternalTokenOptions {
  /** Defaults to `economic-service` — the audience the token is bound to. */
  targetService?: string;
  purpose?: 'SERVICE' | 'RELAY';
  /**
   * Signed into the token. Omit it to mint the claim-less token a
   * platform-wide internal operation carries, which a tenant-scoped endpoint
   * must refuse with a 403.
   */
  organizationId?: string;
  /** Seconds until expiry. A negative value mints an already-expired token. */
  ttlSeconds?: number;
}

export function internalTokenSecret(config: E2eConfig = e2eConfig()): string {
  return config.internalTokenSecret;
}

export async function mintInternalToken(
  callerService: string,
  options: InternalTokenOptions = {},
  config: E2eConfig = e2eConfig(),
): Promise<string> {
  const ttl = options.ttlSeconds ?? 300;
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    svc: callerService,
    purpose: options.purpose ?? 'SERVICE',
    ...(options.organizationId ? { org_id: options.organizationId } : {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('rasta-internal')
    .setAudience(options.targetService ?? 'economic-service')
    .setSubject(callerService)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(new TextEncoder().encode(internalTokenSecret(config)));
}
