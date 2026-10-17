import { Inject, Injectable } from '@nestjs/common';
import { PLATFORM_ROLES, RastaError, getContext } from '@rasta/nest-common';
import { ENV } from '../tokens';
import type { AnalyticsEnv } from '../config/env';

/**
 * Authorization for analytics-service's tenant views (AGENTS.md S-02, S-03; ADR-071 § 4).
 *
 * ## One organization, the one the request acts for
 *
 * A tenant dashboard is the aggregate of the organization the request acts for (the token's,
 * signed — ADR-060), read through the tenant guard. There is no parent-organization view and no
 * service caller. Another organization's dashboard is not addressable at all: no route names an
 * organization, so "read B's dashboard" can only mean acting for B, which the gateway and the
 * guard allow only to a member of B.
 *
 * ## Who, from configuration
 *
 * The readers come from `ANALYTICS_FLEET_DASHBOARD_ROLES`, so no controller carries a static
 * `@Roles(...)`: a decorator is fixed at compile time and would either ignore the configuration
 * or silently disagree with it (the reasoning Q-64 applied to organization policies). The routes
 * stay closed: `AuthGuard` demands a token, `RolesGuard` refuses `AUDITOR` on every handler that
 * does not name it, and this class refuses every role the configuration did not grant.
 *
 * `SYSTEM_ADMIN` is accepted, as `RolesGuard.SUPER_ROLE` is everywhere on the platform — but only
 * while acting for an organization it selected with `X-Organization-Id`: "all organizations" is
 * not a tenant, and their sum is the governance view's, not this one's (ADR-071 § 4).
 *
 * ## The oversight role, three times
 *
 * `AUDITOR` reads aggregate governance views only (`docs/09` § 9.3) — a tenant dashboard is one
 * organization's detail. It is refused by `RolesGuard` (no handler here names it), again by
 * {@link assertNotAuditor} even if the configuration were edited to include it, and the
 * configuration refuses to start with it listed (`config/env.ts`).
 */

export const SUPER_ROLE = 'SYSTEM_ADMIN';
const OVERSIGHT_ROLE = 'AUDITOR';

@Injectable()
export class DashboardAccess {
  private readonly fleetReaders: readonly string[];

  constructor(@Inject(ENV) env: AnalyticsEnv) {
    // Here rather than in `config/env.ts`, which loads before telemetry and may not reach
    // @rasta/nest-common: a role the platform does not have stops startup all the same, since
    // Nest builds this provider at boot.
    const unknown = env.ANALYTICS_FLEET_DASHBOARD_ROLES.filter(
      (role) => !(PLATFORM_ROLES as readonly string[]).includes(role),
    );
    if (unknown.length > 0) {
      throw new Error(`Unknown role in ANALYTICS_FLEET_DASHBOARD_ROLES: ${unknown.join(', ')}`);
    }
    this.fleetReaders = [SUPER_ROLE, ...env.ANALYTICS_FLEET_DASHBOARD_ROLES];
  }

  /** May the caller read the fleet dashboard? Answers the organization it is read for. */
  assertCanReadFleet(): string {
    assertNotAuditor();
    assertNotServiceCaller();

    const context = getContext();
    if (!this.fleetReaders.some((role) => context.roles.includes(role))) {
      throw RastaError.insufficientRole([...this.fleetReaders], context.roles);
    }
    if (!context.organizationId) {
      // Reached by a SYSTEM_ADMIN token with no active tenant. Refused with a reason rather
      // than left to the tenant guard's 500.
      throw RastaError.forbidden(
        'Select an organization with X-Organization-Id to read its dashboard; a tenant dashboard is one organization’s',
      );
    }
    return context.organizationId;
  }
}

export function assertNotAuditor(): void {
  if (getContext().roles.includes(OVERSIGHT_ROLE)) {
    throw RastaError.forbidden(
      'The oversight role reads aggregate governance views only, not one organization’s dashboard',
    );
  }
}

export function assertNotServiceCaller(): void {
  if (getContext().authType === 'SERVICE') {
    throw RastaError.forbidden('No service-to-service access to dashboards is granted');
  }
}
