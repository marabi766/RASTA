import { fetchDrivers } from './drivers';
import { fetchMembers, memberName, type Member } from './members';
import { rolesGuardAdmits } from './roles-guard';
import type { WebSession } from './session';

/**
 * Who the registration form may offer, and the names the driver list may show
 * (task 095).
 *
 * A driver is a member of this organization (fleet-service asks
 * identity-service on every registration). The form used to ask for a raw
 * `USR_…` id the portal shows nowhere an administrator could find it. For a
 * person who may already list the members — identity-service's
 * `GET /v1/users`, `ORGANIZATION_ADMIN` or `UNION_ADMIN` — it now offers them
 * by name and username, without the ones who already have a driver row here,
 * in any status (fleet-service keeps one row per person and organization). No
 * new endpoint: the same two reads the organizations page and the driver list
 * already make, every page of each.
 *
 * ## Never "nobody" while a page remains
 *
 * Both reads are followed to their last page. A read that fails, or that has
 * more pages than {@link ROSTER_MAX_PAGES}, gives no list at all
 * (`UNLISTED`): an incomplete member list would hide a member, and an
 * incomplete driver list would offer someone who is already a driver. The form
 * then keeps the id field, and fleet-service still decides.
 *
 * ## What the list does not decide
 *
 * The offer is a convenience, not a check. identity-service lists ACTIVE
 * memberships without their validity window, so a lapsed member can be
 * offered; fleet-service refuses them on the POST, as it refuses anyone it is
 * sent. A person without the member-list right (`FLEET_MANAGER`) keeps the id
 * field, validated the same way.
 */

/** The roles identity-service's `GET /v1/users` admits (`identity.controller.ts`). */
const MEMBER_LIST_ROLES: readonly string[] = ['ORGANIZATION_ADMIN', 'UNION_ADMIN'];

export function canListMembers(roles: readonly string[]): boolean {
  return rolesGuardAdmits(roles, MEMBER_LIST_ROLES);
}

/** Rows per page of each read; the services cap a page at 200. */
export const ROSTER_PAGE_SIZE = 100;

/** Pages of each read before the list is given up as too long to be complete. */
export const ROSTER_MAX_PAGES = 20;

export interface RosterPerson {
  readonly userId: string;
  readonly name: string;
  readonly username: string;
}

export type DriverRoster =
  /** Every member and every driver read: `candidates` is complete. */
  | {
      readonly kind: 'LISTED';
      readonly candidates: readonly RosterPerson[];
      readonly names: ReadonlyMap<string, RosterPerson>;
    }
  /**
   * No list to offer. `names` is the complete member list when that much was
   * read (the drivers' read is what failed), otherwise null.
   */
  | {
      readonly kind: 'UNLISTED';
      readonly reason: 'NOT_ALLOWED' | 'INCOMPLETE' | 'UNAVAILABLE';
      readonly names: ReadonlyMap<string, RosterPerson> | null;
    };

type PagesRead<T> = { kind: 'ALL'; items: T[] } | { kind: 'INCOMPLETE' } | { kind: 'UNAVAILABLE' };

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

type PageResult<T> = { kind: 'OK'; data: Page<T> } | { kind: string };

async function everyPage<T>(
  read: (cursor: string | undefined) => Promise<PageResult<T>>,
): Promise<PagesRead<T>> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < ROSTER_MAX_PAGES; page += 1) {
    const result = await read(cursor);
    if (result.kind !== 'OK') return { kind: 'UNAVAILABLE' };
    const { data } = result as { kind: 'OK'; data: Page<T> };
    items.push(...data.items);
    if (!data.hasMore) return { kind: 'ALL', items };
    // More pages and no way to ask for them: not a complete list.
    if (!data.nextCursor) return { kind: 'INCOMPLETE' };
    cursor = data.nextCursor;
  }
  return { kind: 'INCOMPLETE' };
}

function personOf(member: Member): RosterPerson {
  return { userId: member.id, name: memberName(member), username: member.username };
}

export async function loadDriverRoster(
  session: WebSession,
  roles: readonly string[] | null,
): Promise<DriverRoster> {
  if (roles === null || !canListMembers(roles)) {
    return { kind: 'UNLISTED', reason: 'NOT_ALLOWED', names: null };
  }

  const members = await everyPage<Member>((cursor) =>
    fetchMembers(session, { cursor, limit: ROSTER_PAGE_SIZE }),
  );
  if (members.kind !== 'ALL') return { kind: 'UNLISTED', reason: members.kind, names: null };

  const names = new Map(members.items.map((member) => [member.id, personOf(member)]));

  const drivers = await everyPage<{ userId: string }>((cursor) =>
    fetchDrivers(session, { cursor }, ROSTER_PAGE_SIZE),
  );
  if (drivers.kind !== 'ALL') return { kind: 'UNLISTED', reason: drivers.kind, names };

  const registered = new Set(drivers.items.map((driver) => driver.userId));
  const candidates = members.items
    // A user who is not ACTIVE cannot act, and fleet-service refuses them.
    .filter((member) => member.status === 'ACTIVE' && !registered.has(member.id))
    .map(personOf)
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, 'fa') ||
        a.username.localeCompare(b.username) ||
        a.userId.localeCompare(b.userId),
    );

  return { kind: 'LISTED', candidates, names };
}
