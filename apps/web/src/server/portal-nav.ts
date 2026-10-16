import { portalNavFor } from '@/app/nav';
import { canReadSettlements } from '@/app/portal-nav';
import type { SidebarItem } from '@/ui';

import { webServerEnv, type WebServerEnv } from './env';
import { fetchCurrentUser, type CurrentUserResult } from './identity';
import { requestRoles } from './realm-roles';
import type { WebSession } from './session';

/**
 * Which navigation a signed-in person is shown.
 *
 * The entries that depend on the person are Projects and Tenders. Whether they
 * may read them is construction-service's decision and stays there: this only
 * decides whether to *draw the link*, from a setting that mirrors the
 * service's (`WEB_PROJECT_ROLES` / `WEB_PROJECT_READER_ROLES`, which must be
 * changed together with `CONSTRUCTION_PROJECT_ROLES` /
 * `CONSTRUCTION_PROJECT_READER_ROLES`). Tenders reuse those two settings for the
 * owner's side — the service gates tender reads by the same configured roles —
 * and add the bidder's side, whose `CONTRACTOR` role is fixed in the service.
 * A person who types `/projects` or `/tenders` anyway is given the service's
 * own answer.
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

/** The bidder's role in its own organization (construction-service `CONTRACTOR_ROLE`, ADR-066 § 4). */
const BIDDER_ROLE = 'CONTRACTOR';

/**
 * Roles construction-service refuses on the bidder's side, whenever present and
 * whatever else the person holds: a token with `SYSTEM_ADMIN` and `CONTRACTOR`
 * is not a contractor (`BIDDER_EXCLUDED_ROLES`). The role itself is not
 * configurable there, so there is no setting here either.
 */
const BIDDER_EXCLUDED_ROLES: readonly string[] = [ALWAYS_READS_PROJECTS, NEVER_READS_PROJECTS];

/**
 * Which of the two tender doors a person is worth *offering* (EXP-004 slice 2):
 *
 * - `owner` — `GET /v1/tenders`, gated by construction-service exactly as
 *   projects are (the same configured roles; docs/24 Q-69), so it is the same
 *   test as {@link canReadProjects}, `AUDITOR` rule included;
 * - `bidder` — `GET /v1/open-tenders`, which needs `CONTRACTOR` and refuses
 *   `SYSTEM_ADMIN` and `AUDITOR` whenever present.
 *
 * Like the Projects link, this decides what to draw and which door to knock on
 * first; the service still decides on every request.
 */
export function tenderSidesFor(
  roles: readonly string[],
  settings: Pick<WebServerEnv, 'WEB_PROJECT_ROLES' | 'WEB_PROJECT_READER_ROLES'>,
): { readonly owner: boolean; readonly bidder: boolean } {
  return {
    owner: canReadProjects(roles, settings),
    bidder:
      roles.includes(BIDDER_ROLE) && !BIDDER_EXCLUDED_ROLES.some((role) => roles.includes(role)),
  };
}

/**
 * Which doors `/tenders` knocks on for a person. The bidder's door for a
 * bidder; the owner's door for an owner — and also for somebody the settings say
 * is neither, so that a person who types the address gets construction-service's
 * own refusal rather than the portal's guess about it.
 */
export function tenderDoorsFor(
  roles: readonly string[],
  settings: Pick<WebServerEnv, 'WEB_PROJECT_ROLES' | 'WEB_PROJECT_READER_ROLES'>,
): { readonly own: boolean; readonly open: boolean } {
  const sides = tenderSidesFor(roles, settings);
  return { own: sides.owner || !sides.bidder, open: sides.bidder };
}

export function canReadTenders(
  roles: readonly string[],
  settings: Pick<WebServerEnv, 'WEB_PROJECT_ROLES' | 'WEB_PROJECT_READER_ROLES'>,
): boolean {
  const sides = tenderSidesFor(roles, settings);
  return sides.owner || sides.bidder;
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
 * Whether supplier-service would let these roles read `/v1/suppliers`, so the
 * Suppliers link is worth drawing.
 *
 * Unlike Projects and Inventory, this is not a setting: supplier-service's
 * `DIRECTORY_ROLES` (`services/supplier-service/src/access/access.ts`) is a
 * fixed export, not read from its own environment, so there is nothing here
 * to make configurable either — mirroring a hard-coded list with another
 * hard-coded list. This **mirrors that list exactly** and must change
 * together with it: `SYSTEM_ADMIN`, `UNION_ADMIN` (`PLATFORM_ROLES`),
 * `ORGANIZATION_ADMIN`, `SUPPLIER`, `WORKSHOP`, `CONTRACTOR`
 * (`SUPPLIER_SIDE_ROLES`), plus `PROCUREMENT_USER` and `FLEET_MANAGER`.
 * `AUDITOR` is absent from that list already, so it is refused here too
 * without a separate check.
 */
const SUPPLIER_DIRECTORY_ROLES: readonly string[] = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'ORGANIZATION_ADMIN',
  'SUPPLIER',
  'WORKSHOP',
  'CONTRACTOR',
  'PROCUREMENT_USER',
  'FLEET_MANAGER',
];

export function canReadSuppliers(roles: readonly string[]): boolean {
  return roles.some((role) => SUPPLIER_DIRECTORY_ROLES.includes(role));
}

/**
 * The navigation for a person, from the roles identity-service reports for the
 * organization they are acting in plus the global realm roles in their token
 * (`SYSTEM_ADMIN`), which is the set the backend services act on.
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
  // The realm claim is read only once identity answered: with no answer the gated
  // links stay hidden, whatever the token says.
  const roles =
    result.kind === 'USER' ? requestRoles(result.user.effectiveRoles, session.accessToken) : [];
  return portalNavFor({
    canReadProjects: canReadProjects(roles, webServerEnv()),
    canReadTenders: canReadTenders(roles, webServerEnv()),
    canReadSettlements: canReadSettlements(result.kind === 'USER' ? roles : null),
    canReadInventory: canReadInventory(roles, webServerEnv()),
    canReadSuppliers: canReadSuppliers(roles),
  });
}
