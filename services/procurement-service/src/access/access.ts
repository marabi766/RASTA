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
 * ## The invited supplier, the one other organization (plan PR 6)
 *
 * An RFQ is its buyer's too, and one other kind of organization reads it: one the RFQ invites,
 * through a person holding a role `PROCUREMENT_SUPPLIER_ROLES` names there (default `SUPPLIER`).
 * That read crosses the tenant guard with a written reason (`RfqRepository`), its predicate always
 * the invitation of the organization the token names (ADR-070 § 10). An RFQ that does not invite
 * it is 404, like one that does not exist. A supplier never commands an RFQ: on the buyer's
 * commands it is 404 too, as is any third organization; another role of the buyer is 403.
 *
 * ## Who, from configuration
 *
 * The roles come from `PROCUREMENT_DEMAND_ROLES` (and, for cancelling an aggregation,
 * `PROCUREMENT_RFQ_ISSUER_ROLES`), so no controller carries a static `@Roles(...)`:
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

/** A person acting for an organization, whose role is judged once the RFQ is found (plan PR 6). */
export interface RfqCaller extends Acting {
  readonly roles: readonly string[];
}

/** Which grant a buyer-side RFQ route needs. */
export type RfqBuyerGrant = 'read' | 'command';

@Injectable()
export class ProcurementAccess {
  private readonly demandRoles: readonly string[];
  private readonly rfqIssuerRoles: readonly string[];
  private readonly settingRoles: readonly string[];
  private readonly supplierRoles: readonly string[];

  constructor(@Inject(ENV) env: ProcurementEnv) {
    this.demandRoles = env.PROCUREMENT_DEMAND_ROLES;
    this.rfqIssuerRoles = env.PROCUREMENT_RFQ_ISSUER_ROLES;
    this.settingRoles = env.PROCUREMENT_AGGREGATION_SETTING_ROLES;
    this.supplierRoles = env.PROCUREMENT_SUPPLIER_ROLES;
  }

  /**
   * The caller of an RFQ route, judged before anything is read: a signed-in person acting for an
   * organization — never the oversight role, a service or the platform operator, which are neither
   * a buyer nor a supplier (ADR-070 § 4, § 10). Its role is judged by {@link assertRfqBuyerRole}
   * once the RFQ is found in its own organization, or by {@link mayReadAsSupplier} for an RFQ it is
   * invited to — so a supplier and a third organization get, on the buyer's commands, the same 404
   * a missing id gets (ADR-070 § 3).
   */
  assertRfqCaller(): RfqCaller {
    assertNotAuditor();
    assertNotServiceCaller();
    const context = getContext();
    if (context.roles.includes(PLATFORM_ROLE)) {
      throw RastaError.forbidden(
        'The platform administrator is neither the buyer nor a supplier of an RFQ',
      );
    }
    if (!context.organizationId) {
      throw RastaError.forbidden('An RFQ is read and changed for an organization');
    }
    return { organizationId: context.organizationId, roles: context.roles };
  }

  /**
   * The buyer side of an RFQ found in the caller's own organization: commands (close, cancel) by
   * `PROCUREMENT_RFQ_ISSUER_ROLES`; reads by those and `PROCUREMENT_DEMAND_ROLES` (`docs/09` gives
   * `PROCUREMENT_USER` `rfq:read`). Any other role of the buyer is 403.
   */
  assertRfqBuyerRole(caller: RfqCaller, grant: RfqBuyerGrant): void {
    const granted = grant === 'command' ? this.rfqIssuerRoles : this.rfqReaderRoles();
    if (!granted.some((role) => caller.roles.includes(role))) {
      throw RastaError.insufficientRole(granted, [...caller.roles]);
    }
  }

  /** Whether the caller holds, in its own organization, a role that reads the RFQs it is invited to. */
  mayReadAsSupplier(caller: RfqCaller): boolean {
    return this.supplierRoles.some((role) => caller.roles.includes(role));
  }

  /** The buyer's list of its RFQs: the read roles, judged first (there is no row to find). */
  assertRfqBuyerReader(): Acting {
    return this.assertBuyerRole(this.rfqReaderRoles());
  }

  /** The supplier's list of the RFQs it is invited to: `PROCUREMENT_SUPPLIER_ROLES`, judged first. */
  assertRfqSupplierReader(): Acting {
    const caller = this.assertRfqCaller();
    if (!this.mayReadAsSupplier(caller)) {
      throw RastaError.insufficientRole(this.supplierRoles, [...caller.roles]);
    }
    return { organizationId: caller.organizationId };
  }

  private rfqReaderRoles(): readonly string[] {
    return [...new Set([...this.rfqIssuerRoles, ...this.demandRoles])];
  }

  /**
   * The caller of every demand and aggregation route — a command or a read: a signed-in person
   * acting for an organization, holding a role `PROCUREMENT_DEMAND_ROLES` names there. Never the
   * oversight role, a service or the platform operator.
   */
  assertBuyer(): Acting {
    return this.assertBuyerRole(this.demandRoles);
  }

  /**
   * The caller of a command on the buyer's aggregation as a whole — cancelling a READY one (plan
   * PR 2; issuing its RFQ from PR 6): the same buyer side, holding a role
   * `PROCUREMENT_RFQ_ISSUER_ROLES` names (ADR-070 § 3, default `ORGANIZATION_ADMIN`).
   */
  assertRfqIssuer(): Acting {
    return this.assertBuyerRole(this.rfqIssuerRoles);
  }

  /** Records the organization's aggregation settings (Q-119 (2)). */
  assertSettingWriter(): Acting {
    return this.assertBuyerRole(this.settingRoles);
  }

  /**
   * Reads the settings in force: whoever records them, and whoever registers demands — the
   * windows a demand opens take them, so its requester may know what they are.
   */
  assertSettingReader(): Acting {
    return this.assertBuyerRole([...new Set([...this.settingRoles, ...this.demandRoles])]);
  }

  private assertBuyerRole(granted: readonly string[]): Acting {
    assertNotAuditor();
    assertNotServiceCaller();
    const context = getContext();
    if (context.roles.includes(PLATFORM_ROLE)) {
      throw RastaError.forbidden(
        'The platform administrator does not act for a buyer’s procurement: its demands, aggregations or settings',
      );
    }
    if (!granted.some((role) => context.roles.includes(role))) {
      throw RastaError.insufficientRole(granted, context.roles);
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
  resource: 'DemandRequest' | 'DemandAggregation' | 'Rfq',
): void {
  if (row.organizationId !== acting.organizationId) {
    throw RastaError.notFound(resource, row.id);
  }
}
