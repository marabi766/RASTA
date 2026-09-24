/**
 * When a membership grants anything.
 *
 * A membership is *live* while it is `ACTIVE` and `now` lies inside
 * `[validFrom, validUntil)`. Outside that window it grants nothing — not an
 * organization in the token, not a role, not the right to act for the
 * organization — whatever its status says. `validUntil` is chosen by whoever
 * granted the membership; a membership that ended yesterday and still worked
 * today would make the field decorative.
 *
 * One definition, used by every decision that asks "does this user belong to
 * this organization right now": the Keycloak projection, switching the active
 * organization, and choosing where a user lands when their active organization
 * stops being one of theirs. Two definitions would drift, and the drift would
 * be an access-control bug.
 *
 * The end is exclusive: at exactly `validUntil` the membership has ended.
 */

export interface MembershipWindow {
  status: string;
  validFrom: Date;
  validUntil: Date | null;
}

export function isMembershipLive(membership: MembershipWindow, now: Date): boolean {
  return (
    membership.status === 'ACTIVE' &&
    membership.validFrom <= now &&
    (membership.validUntil === null || membership.validUntil > now)
  );
}

/** The same predicate, as a Prisma `where` fragment for queries that select live memberships. */
export function liveMembershipWhere(now: Date) {
  return {
    status: 'ACTIVE' as const,
    deletedAt: null,
    validFrom: { lte: now },
    OR: [{ validUntil: null }, { validUntil: { gt: now } }],
  };
}
