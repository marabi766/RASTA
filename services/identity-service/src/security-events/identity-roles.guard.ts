import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, RolesGuard } from '@rasta/nest-common';
import { markRefusal, rolesGuardSiteFor } from './refusal-sites';

interface RouteAwareRequest {
  method?: unknown;
  /** Express's matched route. `path` is the template, never the concrete URL. */
  route?: { path?: unknown };
}

/**
 * identity-service's role guard: the platform `RolesGuard`, unchanged, plus
 * audit marking of the role refusals this service allowlists (ADR-053 § 4,
 * AUD-004 Phases C3–C6).
 *
 * ## Authorization is the shared guard's, and only the shared guard's
 *
 * Every call is delegated to an instance of `@rasta/nest-common`'s
 * `RolesGuard`. Public endpoints, endpoints without `@Roles`, service
 * callers, `SYSTEM_ADMIN`, a missing request context — every branch is its
 * logic, not a copy of it. Its return value is returned and its error is
 * thrown, both as they were. The shared package learns nothing about audit or
 * identity (A-03): this class is the adaptor, and it lives here.
 *
 * ## What it adds
 *
 * When the shared guard refuses with `INSUFFICIENT_ROLE`, and the request's
 * matched method and route template are allowlisted as a `ROLES_GUARD` site in
 * `refusal-sites.ts`, the **same** error object is marked with that site
 * before it is rethrown. The mark lives in a `WeakMap`, so the error's class,
 * fields, message and serialisation — and therefore the `403` the platform
 * filter builds from it — are identical to an unmarked one. The decision to
 * mark reads no status code and no URL: only the shared guard's own
 * classification and Express's matched route.
 *
 * Marking is best-effort in the same sense capture is: if deciding whether to
 * mark ever failed, the original refusal is still thrown, unmarked.
 */
@Injectable()
export class IdentityRolesGuard implements CanActivate {
  private readonly platform: RolesGuard;

  constructor(reflector: Reflector) {
    this.platform = new RolesGuard(reflector);
  }

  canActivate(execution: ExecutionContext): boolean {
    try {
      return this.platform.canActivate(execution);
    } catch (error) {
      markIfAllowlisted(error, execution);
      throw error;
    }
  }
}

function markIfAllowlisted(error: unknown, execution: ExecutionContext): void {
  try {
    if (!(error instanceof RastaError) || error.code !== ERROR_CODES.INSUFFICIENT_ROLE) return;
    if (execution.getType() !== 'http') return;
    const request = execution.switchToHttp().getRequest<RouteAwareRequest>();
    const site = rolesGuardSiteFor(request.method, request.route?.path);
    if (site !== undefined) markRefusal(error, site);
  } catch {
    // Never let audit marking change or replace the refusal being thrown.
  }
}
