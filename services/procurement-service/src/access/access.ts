import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { ENV } from '../tokens';
import type { ProcurementEnv } from '../config/env';

/**
 * Authorization for procurement-service (AGENTS.md S-02, S-03; ADR-070 § 10).
 *
 * ## The buyer's own organization, nobody else
 *
 * A demand and the aggregation it joined belong to one organization — the buyer (Q-119 (1): an
 * aggregation never spans organizations, and the database refuses a demand whose aggregation is
 * another organization's). Only that organization reads or changes them; any other organization
 * finds them `404`, never `403`, and cannot tell "missing" from "not yours" (ADR-011). There is no
 * parent-organization visibility (Q-119 note of 2026-10-16: no union exception) and no service
 * caller.
 *
 * ## Who, from configuration
 *
 * The roles come from `PROCUREMENT_DEMAND_ROLES`, so no controller carries a static `@Roles(...)`:
 * a decorator is fixed at compile time and would either ignore the configuration or silently
 * disagree with it (Q-64, ADR-068 § 7). The routes stay closed: `AuthGuard` demands a token,
 * `RolesGuard` refuses `AUDITOR` on any handler that does not name it, and this class refuses every
 * role the configuration did not grant.
 *
 * ## The platform operator and the oversight role
 *
 * `SYSTEM_ADMIN` is not on the buyer side (ADR-070 § 5; the provisional answer recorded with
 * Q-119): it neither registers, withdraws nor reads a buyer's need, whatever organization it
 * selected, and the configuration refuses to name it. `AUDITOR` has aggregate access only
 * (`docs/09` § 9.3): refused by `RolesGuard`, again here, and by the configuration at startup.
 * Both refusals come before any row is read, so they disclose nothing about what exists.
 */

const PLATFORM_ROLE = 'SYSTEM_ADMIN';
const OVERSIGHT_ROLE = 'AUDITOR';

/** Who is acting: the organization the signed token names, and nothing else. */
export interface Acting {
  readonly organizationId: string;
}

@Injectable()
export class ProcurementAccess {
  private readonly demandRoles: readonly string[];

  constructor(@Inject(ENV) env: ProcurementEnv) {
    this.demandRoles = env.PROCUREMENT_DEMAND_ROLES;
  }

  /**
   * The caller of every demand and aggregation route — a command or a read: a signed-in person
   * acting for an organization, holding a role `PROCUREMENT_DEMAND_ROLES` names there. Never the
   * oversight role, a service or the platform operator.
   */
  assertBuyer(): Acting {
    assertNotAuditor();
    assertNotServiceCaller();
    const context = getContext();
    if (context.roles.includes(PLATFORM_ROLE)) {
      throw RastaError.forbidden(
        'The platform administrator does not register, withdraw or read a buyer’s demands',
      );
    }
    if (!this.demandRoles.some((role) => context.roles.includes(role))) {
      throw RastaError.insufficientRole(this.demandRoles, context.roles);
    }
    if (!context.organizationId) {
      throw RastaError.forbidden('A demand is registered and read for an organization');
    }
    return { organizationId: context.organizationId };
  }
}

export function assertNotAuditor(): void {
  if (getContext().roles.includes(OVERSIGHT_ROLE)) {
    throw RastaError.forbidden(
      'The oversight role has aggregate access only and no access to individual demands',
    );
  }
}

export function assertNotServiceCaller(): void {
  if (getContext().authType === 'SERVICE') {
    throw RastaError.forbidden('No service-to-service access to demands is granted');
  }
}

/**
 * The row-level half of tenant isolation: `404` for any demand or aggregation of another
 * organization, whatever query produced it.
 */
export function assertOwnedBy(
  row: { id: string; organizationId: string },
  acting: Acting,
  resource: 'DemandRequest' | 'DemandAggregation',
): void {
  if (row.organizationId !== acting.organizationId) {
    throw RastaError.notFound(resource, row.id);
  }
}
