import { SETTLEMENT_READ_ROLES } from '@/lib/settlement-fields';
import { fetchCurrentUser } from '@/server/identity';
import type { WebSession } from '@/server/session';
import type { SidebarItem } from '@/ui';

import { PORTAL_NAV, SETTLEMENTS_NAV_ITEM } from './nav';

/**
 * The navigation a person is offered, given the roles they hold.
 *
 * An entry whose route admits only some roles appears for them alone. **This
 * is UX, not access control** — hiding a link refuses nobody, and the gateway
 * and the service decide on every request. When the roles cannot be read the
 * gated entry is left out: the route still answers to anyone who types it,
 * and a link that leads to a refusal is the worse mistake.
 */
export function navForRoles(roles: readonly string[] | null): readonly SidebarItem[] {
  const mayReadSettlements =
    roles !== null && SETTLEMENT_READ_ROLES.some((role) => roles.includes(role));
  if (!mayReadSettlements) return PORTAL_NAV;

  // After the wallet, the other money screen.
  const at = PORTAL_NAV.findIndex((item) => item.href === '/wallet');
  const index = at === -1 ? PORTAL_NAV.length : at + 1;
  return [...PORTAL_NAV.slice(0, index), SETTLEMENTS_NAV_ITEM, ...PORTAL_NAV.slice(index)];
}

export async function portalNavFor(session: WebSession): Promise<readonly SidebarItem[]> {
  const result = await fetchCurrentUser(session);
  return navForRoles(result.kind === 'USER' ? result.user.effectiveRoles : null);
}
