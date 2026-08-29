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
 * The tenant resolution below is the security-critical part, and it works the
 * same way on both paths: **the header is never the authority.**
 *
 *   user token     `X-Organization-Id` is checked against the memberships in
 *                  the verified token (ADR-011)
 *   service token  `X-Organization-Id` is checked against the signed `org_id`
 *                  claim in the internal token (ADR-035)
 *
 * In both cases a header that does not agree is refused, never resolved. This
 * is the exact point at which a mistake becomes a tenant escape.
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

    const bearer = extractBearer(headerValue(request, 'authorization'));
    const internalToken = headerValue(request, 'x-internal-token');

    // A gateway-forwarded request carries BOTH: the caller's user token and an
    // internal token proving the hop came from the gateway. The user token
    // wins, because it names the actual actor — the internal token only says
    // which service relayed it.
    //
    // An internal token on its own is either a genuine service-to-service
    // call or the gateway relaying a request that had no credentials. Those
    // two mean very different things, and the token itself says which.
    if (internalToken && !bearer) {
      const state = await this.authenticateInternal(
        execution,
        request,
        internalToken,
        publicMeta?.public === true,
      );
      request.rastaAuth = state;
      upgradeContext(state);
      return true;
    }
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

  private async authenticateInternal(
    execution: ExecutionContext,
    request: AuthenticatedRequest,
    token: string,
    isPublicEndpoint: boolean,
  ): Promise<AuthState> {
    if (!this.options.internalTokens) {
      throw RastaError.unauthenticated('Service-to-service authentication is not configured');
    }

    // Verified either way. The token proves the hop is internal; what it
    // *authorizes* depends on why it was minted.
    const claims = await this.options.internalTokens.verify(token, this.options.serviceName);

    // The gateway relaying a request that carried no credentials of its own.
    // The token names the hop, not an actor, so this is an anonymous request
    // and `@Public` decides it — exactly as if the caller had reached the
    // service directly.
    //
    // Reading this as a service-to-service call is what broke every public
    // endpoint behind the gateway: self-registration, the one door a new user
    // can walk through, answered 403 because it carries no `@AllowService`
    // (D-007). Opening it by loosening `@AllowService` would have been the
    // wrong repair — a relay token deliberately grants *less* than a service
    // token, never more.
    if (claims.purpose === 'RELAY') {
      if (!isPublicEndpoint) {
        // Not a leak: an anonymous caller learns only that the endpoint needs
        // authentication, which the gateway would already have told them.
        throw RastaError.unauthenticated('Missing bearer token');
      }
      return { authType: 'ANONYMOUS', roles: [] };
    }

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

    // The tenant comes from the **signed** claim, never from the header
    // (ADR-035). An unsigned `X-Organization-Id` can be written by anything
    // that reaches this service, so honouring it would turn a leaked internal
    // token from "impersonate one service" into "act for any organization".
    //
    // The header is still allowed — the gateway and the calling service both
    // propagate it for correlation and logging — but it may only *agree* with
    // the claim. Disagreement is refused rather than resolved, because the two
    // sources disagreeing means one of them is lying and there is no way to
    // tell which.
    const requestedTenant = headerValue(request, 'x-organization-id');
    if (requestedTenant && requestedTenant !== claims.organizationId) {
      throw RastaError.serviceTenantContextInvalid('HEADER_CLAIM_MISMATCH', {
        callerService: claims.callerService,
      });
    }

    return {
      authType: 'SERVICE',
      callerService: claims.callerService,
      // Undefined for a platform-wide operation. A tenant-scoped one that
      // reaches `getOrganizationId()` with nothing here is refused there, with
      // a 403 rather than the raw error that used to surface as a 500.
      organizationId: claims.organizationId,
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
