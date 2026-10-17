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
 * ## The one second organization: a shipment's consignee
 *
 * A shipment is read by the owner of its origin warehouse **or** by its consignee (ADR-056 § 5),
 * each through its own roles (`assertShipmentReader`); a third organization finds it `404`. The
 * consignee only reads — every shipment command is the owner's operators'.
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

/**
 * The sides of a shipment the acting organization may read it from (ADR-056 § 5): as the owner of
 * its origin warehouse, as its consignee, or both — each opened by its own roles.
 */
export interface ShipmentReader {
  readonly organizationId: string;
  readonly asOrigin: boolean;
  readonly asConsignee: boolean;
}

/**
 * The sides of a return shipment the acting organization may read it from (ADR-048 § 2): as the
 * owner of its destination warehouse, as its sender, or both — each opened by its own roles.
 */
export interface ReturnShipmentReader {
  readonly organizationId: string;
  readonly asDestination: boolean;
  readonly asSender: boolean;
}

@Injectable()
export class InventoryAccess {
  private readonly operators: readonly string[];
  private readonly readers: readonly string[];
  private readonly consigneeReaders: readonly string[];

  constructor(@Inject(ENV) env: InventoryEnv) {
    this.operators = env.INVENTORY_OPERATOR_ROLES;
    this.readers = [...new Set([...env.INVENTORY_READER_ROLES, ...env.INVENTORY_OPERATOR_ROLES])];
    this.consigneeReaders = env.INVENTORY_CONSIGNEE_READER_ROLES;
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

  /**
   * The caller of a shipment read: a signed-in person of the origin warehouse's owner with a
   * reader or operator role, or of the consignee with a role of INVENTORY_CONSIGNEE_READER_ROLES
   * (Q-113). Which sides the roles open is returned, and the read asks for those sides only — a
   * shipment outside them is `404` like any other organization's.
   */
  assertShipmentReader(): ShipmentReader {
    const organizationId = this.assertPerson();
    const roles = getContext().roles;
    const holds = (granted: readonly string[]) => granted.some((role) => roles.includes(role));
    const reader = {
      organizationId,
      asOrigin: holds(this.readers),
      asConsignee: holds(this.consigneeReaders),
    };
    if (!reader.asOrigin && !reader.asConsignee) {
      throw RastaError.insufficientRole(
        [...new Set([...this.readers, ...this.consigneeReaders])],
        roles,
      );
    }
    return reader;
  }

  /**
   * The caller of a return-shipment read: a signed-in person of the destination warehouse's owner
   * with a reader or operator role, or of the sender with a role of
   * INVENTORY_CONSIGNEE_READER_ROLES — the same roles that open a forward shipment's consignee
   * side (Q-113, Q-133). A return shipment outside the sides the roles open is `404`, like any
   * other organization's.
   */
  assertReturnShipmentReader(): ReturnShipmentReader {
    const organizationId = this.assertPerson();
    const roles = getContext().roles;
    const holds = (granted: readonly string[]) => granted.some((role) => roles.includes(role));
    const reader = {
      organizationId,
      asDestination: holds(this.readers),
      asSender: holds(this.consigneeReaders),
    };
    if (!reader.asDestination && !reader.asSender) {
      throw RastaError.insufficientRole(
        [...new Set([...this.readers, ...this.consigneeReaders])],
        roles,
      );
    }
    return reader;
  }

  /**
   * Whether the caller holds a role that opens a shipment's consignee side (Q-113) — so a
   * command on a shipment it can read but not move is told so (`403`) rather than `404`.
   */
  readsAsConsignee(): boolean {
    const roles = getContext().roles;
    return this.consigneeReaders.some((role) => roles.includes(role));
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
