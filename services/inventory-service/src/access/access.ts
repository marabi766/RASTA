import { Inject, Injectable } from '@nestjs/common';
import { RastaError, currentActor, getContext } from '@rasta/nest-common';
import { ENV } from '../tokens';
import type { InventoryEnv } from '../config/env';

/**
 * Authorization for inventory-service (AGENTS.md S-02, S-03; ADR-056 § 5).
 *
 * ## The owner, and nobody else, in PR 1
 *
 * Every row belongs to the organization that owns its warehouse, and the request acts for one
 * organization — the active one the signed token names (`X-Organization-Id` among the caller's
 * memberships, or `403 TENANT_MISMATCH` before anything here runs). The tenant guard and the
 * explicit `organization_id` of every balance write make another owner's warehouse, stock item,
 * movement or reservation a `404`, never a `403`, and never a hint that it exists (ADR-011).
 * The holder side of a reservation is the owner itself in PR 1 (Q-104); cross-organization
 * holders, and the read path they need, come with the integration PR.
 *
 * ## Who, from configuration
 *
 * Writes need a role of `INVENTORY_OPERATOR_ROLES`, reads one of `INVENTORY_READER_ROLES` or of
 * the operators (Q-103) — roles the caller holds **in the active organization** (ADR-060). No
 * controller names a role: a decorator is fixed at compile time and would either ignore the
 * configuration or disagree with it. The routes stay closed: `AuthGuard` demands a token,
 * `RolesGuard` refuses `AUDITOR` on every handler that does not name it, and this class refuses
 * every role the configuration did not grant.
 *
 * ## Refused whatever the configuration says
 *
 * `AUDITOR` has aggregate access only (`docs/09` § 9.3); `SYSTEM_ADMIN` does not operate or read
 * a warehouse for an organization in PR 1 (Q-103); a service token reaches nothing — no service
 * calls this one yet (ADR-056 § 7). The configuration refuses to start naming either role.
 */

const OVERSIGHT_ROLE = 'AUDITOR';
const PLATFORM_ROLE = 'SYSTEM_ADMIN';

/** Who is acting: the organization the signed token names, and the person. */
export interface Acting {
  readonly organizationId: string;
  /** The person's platform user id — stamped on every row and event they cause. */
  readonly userId: string;
}

@Injectable()
export class InventoryAccess {
  private readonly operators: readonly string[];
  private readonly readers: readonly string[];

  constructor(@Inject(ENV) env: InventoryEnv) {
    this.operators = env.INVENTORY_OPERATOR_ROLES;
    this.readers = [...new Set([...env.INVENTORY_READER_ROLES, ...env.INVENTORY_OPERATOR_ROLES])];
  }

  /** The caller of a command: a signed-in person of the owner with an operator role. */
  assertOperator(): Acting {
    const organizationId = this.assertPerson();
    this.assertHolds(this.operators);
    return { organizationId, userId: currentActor({ requirePlatformUserId: true }).userId };
  }

  /** The caller of a read: a signed-in person of the owner with a reader or operator role. */
  assertReader(): Pick<Acting, 'organizationId'> {
    const organizationId = this.assertPerson();
    this.assertHolds(this.readers);
    return { organizationId };
  }

  private assertPerson(): string {
    const context = getContext();
    if (context.roles.includes(OVERSIGHT_ROLE)) {
      throw RastaError.forbidden(
        'The oversight role has aggregate access only and no access to individual stock',
      );
    }
    if (context.authType === 'SERVICE') {
      throw RastaError.forbidden('No service-to-service access to inventory is granted');
    }
    if (context.roles.includes(PLATFORM_ROLE)) {
      throw RastaError.forbidden(
        'The platform administrator does not operate or read a warehouse for an organization',
      );
    }
    if (!context.organizationId) {
      throw RastaError.forbidden('Inventory is kept for an organization; act for one');
    }
    return context.organizationId;
  }

  private assertHolds(granted: readonly string[]): void {
    const roles = getContext().roles;
    if (!granted.some((role) => roles.includes(role))) {
      throw RastaError.insufficientRole(granted, roles);
    }
  }
}
