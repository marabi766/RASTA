import { portalNavFor } from '@/app/nav';
import { canReadSettlements } from '@/app/portal-nav';
import type { SidebarItem } from '@/ui';

import { webServerEnv, type WebServerEnv } from './env';
import { fetchCurrentUser, type CurrentUserResult } from './identity';
import type { WebSession } from './session';

/**
 * Which navigation a signed-in person is shown.
 *
 * The one entry that depends on the person is Projects. Whether they may read
 * projects is construction-service's decision and stays there: this only
 * decides whether to *draw the link*, from a setting that mirrors the
 * service's (`WEB_PROJECT_ROLES` / `WEB_PROJECT_READER_ROLES`, which must be
 * changed together with `CONSTRUCTION_PROJECT_ROLES` /
 * `CONSTRUCTION_PROJECT_READER_ROLES`). A person who types `/projects` anyway
 * is given the service's own answer.
 */

/** Always accepted by construction-service, so always shown the link. */
const ALWAYS_READS_PROJECTS = 'SYSTEM_ADMIN';

/** Never accepted by construction-service, whatever else the person holds. */
const NEVER_READS_PROJECTS = 'AUDITOR';

export function canReadProjects(
  roles: readonly string[],
  settings: Pick<WebServerEnv, 'WEB_PROJECT_ROLES' | 'WEB_PROJECT_READER_ROLES'>,
): boolean {
  if (roles.includes(NEVER_READS_PROJECTS)) return false;
  if (roles.includes(ALWAYS_READS_PROJECTS)) return true;
  return roles.some(
    (role) =>
      settings.WEB_PROJECT_ROLES.includes(role) || settings.WEB_PROJECT_READER_ROLES.includes(role),
  );
}

/**
 * Whether inventory-service would let these roles read, so the Inventory link
 * is worth drawing. Unlike projects, `SYSTEM_ADMIN` is not admitted: the
 * service refuses the platform administrator, and `AUDITOR`, whatever else the
 * person holds. Everyone else needs a configured operator or reader role.
 */
export function canReadInventory(
  roles: readonly string[],
  settings: Pick<WebServerEnv, 'WEB_INVENTORY_ROLES' | 'WEB_INVENTORY_READER_ROLES'>,
): boolean {
  if (roles.includes('AUDITOR') || roles.includes('SYSTEM_ADMIN')) return false;
  return roles.some(
    (role) =>
      settings.WEB_INVENTORY_ROLES.includes(role) ||
      settings.WEB_INVENTORY_READER_ROLES.includes(role),
  );
}

/**
 * The navigation for a person, from the roles identity-service reports for the
 * organization they are acting in.
 *
 * An identity answer that is missing or unreadable hides the gated link: it is
 * only a convenience, and showing it on a guess is the mistake being fixed. The
 * page that called this renders its own identity outcome where it needs one.
 */
export async function loadPortalNav(
  session: WebSession,
  current?: CurrentUserResult,
): Promise<readonly SidebarItem[]> {
  const result = current ?? (await fetchCurrentUser(session));
  const roles = result.kind === 'USER' ? result.user.effectiveRoles : [];
  return portalNavFor({
    canReadProjects: canReadProjects(roles, webServerEnv()),
    canReadSettlements: canReadSettlements(result.kind === 'USER' ? roles : null),
    canReadInventory: canReadInventory(roles, webServerEnv()),
  });
}
