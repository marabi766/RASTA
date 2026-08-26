import { Injectable, Inject, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RastaError } from '../errors/rasta-error';
import { TokenVerifier, InternalTokenService } from '../auth/token-verifier';
import { IS_PUBLIC_KEY, ALLOW_SERVICE_KEY } from '../decorators';
import { upgradeContext, type RequestContext } from '../context/request-context';

export const AUTH_OPTIONS = Symbol('RASTA_AUTH_OPTIONS');

export interface AuthGuardOptions {
  /** This service's own name — the expected audience of internal tokens. */
  serviceName: string;
  tokenVerifier: TokenVerifier;
  internalTokens?: InternalTokenService;
}

/**
 * Authenticates every request, and resolves which organization it acts for.
 *
 * Registered globally. Endpoints are closed by default; `@Public(reason)` is
 * the only way to open one, which keeps "what is exposed?" answerable by
 * grepping for a single decorator.
 *
 * The tenant resolution below is the security-critical part. A caller may ask
 * to act for a specific organization via `X-Organization-Id`, but that header
 * is never trusted: it is checked against the memberships in the verified
 * token. This is the exact point at which a mistake becomes a tenant escape.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_OPTIONS) private readonly options: AuthGuardOptions,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const request = execution.switchToHttp().getRequest<AuthenticatedRequest>();

    const publicMeta = this.reflector.getAllAndOverride<{ public: boolean } | undefined>(
      IS_PUBLIC_KEY,
      [execution.getHandler(), execution.getClass()],
    );

    const internalToken = headerValue(request, 'x-internal-token');
    if (internalToken) {
      const state = await this.authenticateService(execution, internalToken);
      request.rastaAuth = state;
      upgradeContext(state);
      return true;
    }

    const bearer = extractBearer(headerValue(request, 'authorization'));
    if (!bearer) {
      if (publicMeta?.public) {
        request.rastaAuth = { authType: 'ANONYMOUS', roles: [] };
        return true;
      }
      throw RastaError.unauthenticated('Missing bearer token');
    }

    const claims = await this.options.tokenVerifier.verifyUserToken(bearer);

    const requested = headerValue(request, 'x-organization-id');
    const organizationId = resolveOrganization(
      requested,
      claims.organizationId,
      claims.organizationIds,
    );

    const state: AuthState = {
      authType: 'USER',
      // Prefer the platform id. Falling back to the IdP subject keeps an
      // account provisioned outside the platform usable rather than broken.
      userId: claims.rastaUserId ?? claims.sub,
      subject: claims.sub,
      organizationId,
      roles: claims.roles,
      username: claims.username,
    };

    request.rastaAuth = state;
    upgradeContext({
      authType: 'USER',
      userId: state.userId,
      subject: state.subject,
      organizationId: state.organizationId,
      roles: state.roles,
    });

    return true;
  }

  private async authenticateService(
    execution: ExecutionContext,
    token: string,
  ): Promise<AuthState> {
    if (!this.options.internalTokens) {
      throw RastaError.unauthenticated('Service-to-service authentication is not configured');
    }

    const claims = await this.options.internalTokens.verify(token, this.options.serviceName);

    const allowed = this.reflector.getAllAndOverride<string[] | undefined>(ALLOW_SERVICE_KEY, [
      execution.getHandler(),
      execution.getClass(),
    ]);

    // A valid internal token proves *which* service is calling; it does not by
    // itself grant access to any endpoint. Zero Trust means the callee still
    // decides. See ADR-020.
    if (!allowed) {
      throw RastaError.forbidden('This endpoint is not callable by another service');
    }
    if (allowed.length > 0 && !allowed.includes(claims.callerService)) {
      throw RastaError.forbidden('This service is not permitted to call this endpoint');
    }

    return {
      authType: 'SERVICE',
      callerService: claims.callerService,
      // A service call carries the tenant of the request that caused it, which
      // the caller propagates in the header. There is no membership to check
      // because there is no user; the originating request already checked it.
      roles: ['SERVICE'],
    };
  }
}

/**
 * Decides which organization this request acts for.
 *
 * Rules, in order:
 *  1. No requested org → use the token's active organization.
 *  2. Requested org is in the token's memberships → use it.
 *  3. Otherwise → TENANT_MISMATCH. Never fall back to the active org, because
 *     silently ignoring the header would let a caller believe they were acting
 *     for organization B while the server acted for A.
 */
export function resolveOrganization(
  requested: string | undefined,
  active: string | undefined,
  memberships: readonly string[],
): string | undefined {
  if (!requested) return active;
  if (requested === active) return requested;
  if (memberships.includes(requested)) return requested;

  throw RastaError.tenantMismatch(requested, active ? [active, ...memberships] : memberships);
}

export interface AuthState {
  authType: RequestContext['authType'];
  userId?: string;
  subject?: string;
  organizationId?: string;
  roles: string[];
  username?: string;
  callerService?: string;
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  rastaAuth?: AuthState;
}

function headerValue(request: AuthenticatedRequest, name: string): string | undefined {
  const raw = request.headers[name] ?? request.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') return undefined;
  return value.trim() || undefined;
}
