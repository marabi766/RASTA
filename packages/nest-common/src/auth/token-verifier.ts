import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { RastaError } from '../errors/rasta-error';

/**
 * JWT verification against the identity provider's JWKS.
 *
 * Three things this does that a naive `jwt.verify` does not:
 *
 *  - Pins the algorithm to RS256. Accepting the token's own `alg` header is
 *    how `alg: none` and HS256-signed-with-the-public-key attacks work.
 *  - Checks `aud` and `iss` explicitly. A token minted for another audience by
 *    the same issuer is not a token for us.
 *  - Caches the JWKS with a bounded lifetime and cooldown, so a key rotation
 *    is picked up without hammering the IdP on every request.
 */

export interface UserClaims {
  /** The identity provider's subject. Stable, but not our identifier. */
  sub: string;
  /**
   * The platform's own user id, carried in the `rasta_uid` claim.
   *
   * Without it every request would have to translate the IdP subject into a
   * platform id before it could do anything — a database round trip on the
   * hot path of every single call, purely to convert one identifier to
   * another. Absent only for accounts provisioned outside the platform.
   */
  rastaUserId?: string;
  organizationId?: string;
  organizationIds: string[];
  roles: string[];
  username?: string;
  email?: string;
  expiresAt: number;
}

/**
 * What authority an internal token carries.
 *
 * `SERVICE` — the caller is acting on its own behalf. The callee still decides
 * whether that is allowed, via `@AllowService` (ADR-020).
 *
 * `RELAY` — the api-gateway is forwarding somebody else's request. The token
 * proves the hop came from the gateway; it names no actor and grants no
 * service authority. A relayed request that carried no credentials of its own
 * is simply an anonymous request, and is judged by `@Public` like any other.
 *
 * Keeping these apart is what lets an unauthenticated caller reach a public
 * endpoint through the gateway without the gateway ever being able to mint a
 * token that satisfies `@AllowService` (D-007).
 */
export type InternalTokenPurpose = 'SERVICE' | 'RELAY';

export interface ServiceClaims {
  callerService: string;
  targetService: string;
  purpose: InternalTokenPurpose;
  expiresAt: number;
}

export interface TokenVerifierOptions {
  jwksUri: string;
  issuer: string;
  audience: string;
  /** Tolerance for clock skew between this service and the IdP. */
  clockToleranceSeconds?: number;
}

export class TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly options: TokenVerifierOptions) {
    this.jwks = createRemoteJWKSet(new URL(options.jwksUri), {
      cacheMaxAge: 60 * 60 * 1000, // an hour
      cooldownDuration: 30 * 1000, // at most one refetch per 30s on unknown kid
      timeoutDuration: 5_000,
    });
  }

  async verifyUserToken(token: string): Promise<UserClaims> {
    let payload: JWTPayload;

    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ['RS256'],
        clockTolerance: this.options.clockToleranceSeconds ?? 5,
      });
      payload = result.payload;
    } catch (error) {
      throw mapJoseError(error);
    }

    if (!payload.sub) {
      throw new RastaError('TOKEN_INVALID', 'Token has no subject');
    }

    return {
      sub: payload.sub,
      rastaUserId: readString(payload, 'rasta_uid'),
      organizationId: readString(payload, 'org_id'),
      organizationIds: readStringArray(payload, 'org_ids'),
      roles: readRealmRoles(payload),
      username: readString(payload, 'preferred_username'),
      email: readString(payload, 'email'),
      expiresAt: (payload.exp ?? 0) * 1000,
    };
  }
}

/**
 * Service-to-service tokens.
 *
 * MVP uses a short-lived HS256 token signed with a shared secret. This is a
 * documented simplification (risk S-03): production replaces it with mTLS and
 * per-workload identity per ADR-020. The token is scoped to a single target
 * service so a leaked token for `notification-service` cannot be replayed
 * against `economic-service`.
 */
export class InternalTokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly issuer: string,
    private readonly ttlSeconds: number,
  ) {
    if (secret.length < 32) {
      throw new Error('INTERNAL_TOKEN_SECRET must be at least 32 characters');
    }
    this.key = new TextEncoder().encode(secret);
  }

  async issue(
    callerService: string,
    targetService: string,
    purpose: InternalTokenPurpose = 'SERVICE',
  ): Promise<string> {
    return new SignJWT({ svc: callerService, purpose })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(targetService)
      .setSubject(callerService)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string, expectedTarget: string): Promise<ServiceClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.issuer,
        audience: expectedTarget,
        algorithms: ['HS256'],
        clockTolerance: 5,
      });

      if (!payload.sub) {
        throw new RastaError('TOKEN_INVALID', 'Internal token has no subject');
      }

      return {
        callerService: payload.sub,
        targetService: expectedTarget,
        // Absent means SERVICE: the stricter reading, and what every token
        // minted before the claim existed meant.
        purpose: payload['purpose'] === 'RELAY' ? 'RELAY' : 'SERVICE',
        expiresAt: (payload.exp ?? 0) * 1000,
      };
    } catch (error) {
      throw mapJoseError(error);
    }
  }
}

function mapJoseError(error: unknown): RastaError {
  if (error instanceof RastaError) return error;

  const code = (error as { code?: string })?.code;
  if (code === 'ERR_JWT_EXPIRED') {
    return new RastaError('TOKEN_EXPIRED', 'Token has expired');
  }
  // Everything else — bad signature, wrong audience, wrong issuer, malformed —
  // is reported as a single "invalid" so the response cannot be used to probe
  // which specific check failed.
  return new RastaError('TOKEN_INVALID', 'Token is not valid', {
    internalContext: { joseCode: code, message: (error as Error)?.message },
  });
}

function readString(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(payload: JWTPayload, key: string): string[] {
  const value = payload[key];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

/** Keycloak nests realm roles under `realm_access.roles`. */
function readRealmRoles(payload: JWTPayload): string[] {
  const realmAccess = payload['realm_access'];
  if (realmAccess && typeof realmAccess === 'object' && 'roles' in realmAccess) {
    const roles = (realmAccess as { roles?: unknown }).roles;
    if (Array.isArray(roles)) return roles.filter((r): r is string => typeof r === 'string');
  }
  return [];
}
