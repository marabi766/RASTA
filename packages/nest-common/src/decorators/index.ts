import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { getContext, tryGetContext, type RequestContext } from '../context/request-context';

export const IS_PUBLIC_KEY = 'rasta:isPublic';
export const REQUIRED_ROLES_KEY = 'rasta:requiredRoles';
export const ALLOW_SERVICE_KEY = 'rasta:allowService';
export const IDEMPOTENT_KEY = 'rasta:idempotent';
export const SKIP_TENANT_SCOPE_KEY = 'rasta:skipTenantScope';

/**
 * Marks an endpoint as reachable without authentication.
 *
 * Endpoints are closed by default (`JwtAuthGuard` is global), so this is the
 * only way to open one. The `reason` argument is required rather than
 * decorative: an unauthenticated endpoint should be a deliberate, documented
 * decision that a reviewer can evaluate without leaving the file.
 */
export const Public = (reason: string) => SetMetadata(IS_PUBLIC_KEY, { public: true, reason });

/**
 * Restricts an endpoint to the listed roles.
 *
 * This is coarse authorization only — "may this kind of user do this kind of
 * thing". It says nothing about *which* records they may touch. Object-level
 * authorization is the service layer's job and is never satisfied by this
 * decorator alone. See docs/09-security-architecture.md § 9.3.
 */
export const Roles = (...roles: string[]) => SetMetadata(REQUIRED_ROLES_KEY, roles);

/**
 * Permits an authenticated *service* (not a user) to call this endpoint.
 * Used for internal endpoints under `/internal/v1`.
 */
export const AllowService = (...services: string[]) => SetMetadata(ALLOW_SERVICE_KEY, services);

/**
 * Requires an `Idempotency-Key` header.
 *
 * Mandatory on anything with a financial effect or an irreversible external
 * consequence: order creation, transactions, top-ups, settlements, bid
 * submission, statement approval.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);

/**
 * Declares that a handler intentionally operates across tenants.
 *
 * Reserved for platform-wide administration. Requires an explicit reason so
 * that every cross-tenant path is greppable and reviewable — this decorator
 * is the single place a tenant boundary is legitimately crossed.
 */
export const SkipTenantScope = (reason: string) =>
  SetMetadata(SKIP_TENANT_SCOPE_KEY, { skip: true, reason });

/** Injects the current {@link RequestContext} into a handler parameter. */
export const Ctx = createParamDecorator((_data: unknown, _ctx: ExecutionContext): RequestContext =>
  getContext(),
);

/** Injects the current organization id, throwing if the request has none. */
export const OrgId = createParamDecorator((_data: unknown, _ctx: ExecutionContext): string => {
  const context = getContext();
  if (!context.organizationId) {
    throw new Error('Handler requested OrgId but the request carries no organization');
  }
  return context.organizationId;
});

/** Injects the authenticated user id, or undefined for service/anonymous calls. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext): string | undefined => tryGetContext()?.userId,
);
