import { SETTLEMENT_READ_ROLES } from '@/lib/settlement-fields';
import type { SidebarItem } from '@/ui';

import { portalNavFor } from './nav';

/**
 * Whether the roles admit `GET /v1/settlements`, so the Settlements link is
 * worth drawing. `null` is "roles could not be read".
 *
 * `AUDITOR` is excluded first, whatever else the person holds: economic-service
 * refuses a caller holding it (`assertNotAuditor()`) even alongside an admin role.
 */
export function canReadSettlements(roles: readonly string[] | null): boolean {
  if (roles === null || roles.includes('AUDITOR')) return false;
  return SETTLEMENT_READ_ROLES.some((role) => roles.includes(role));
}

/**
 * The navigation a person is offered, given the roles they hold.
 *
 * An entry whose route admits only some roles appears for them alone. **This
 * is UX, not access control** — hiding a link refuses nobody, and the gateway
 * and the service decide on every request. When the roles cannot be read the
 * gated entry is left out: the route still answers to anyone who types it,
 * and a link that leads to a refusal is the worse mistake.
 *
 * This is the settlements half only; `PortalSidebar` (through
 * `server/portal-nav.ts`) adds the Projects entry, which has its own setting.
 */
export function navForRoles(roles: readonly string[] | null): readonly SidebarItem[] {
  return portalNavFor({ canReadProjects: false, canReadSettlements: canReadSettlements(roles) });
}
