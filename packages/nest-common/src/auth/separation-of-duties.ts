import { ERROR_CODES } from '@rasta/contracts';
import { getContext } from '../context/request-context';
import { RastaError } from '../errors/rasta-error';

/**
 * Who did something, in the form a separation-of-duties rule can compare.
 *
 * `userId` alone cannot be compared. The auth guard sets it from `rasta_uid`
 * and falls back to the IdP subject when that claim is absent, so one person
 * can carry two user ids: the subject on one token, the platform id on another,
 * or two platform ids if the identity provider's mapping is ever wrong (#188).
 * The token's issuer and subject are what stays the same for one person.
 *
 * A service that records an actor for a later comparison (a proposer, an
 * author, a creator) stores all three. `issuer` and `subject` are `null` for a
 * row written before they were recorded: unknown, and {@link compareActors}
 * treats unknown as unknown, never as "a different person".
 */
export interface ActorIdentity {
  readonly userId: string;
  readonly issuer: string | null;
  readonly subject: string | null;
}

/**
 * The outcome of comparing two actors.
 *
 *   SAME      provably one person
 *   DISTINCT  provably two people
 *   UNKNOWN   neither can be proven: at least one side has no recorded
 *             issuer and subject, and nothing else matched
 */
export type ActorComparison = 'SAME' | 'DISTINCT' | 'UNKNOWN';

/** The fixed refusal for a route that needs the platform user id. No claim values. */
export function platformUserIdRequired(): RastaError {
  return RastaError.forbidden('This action requires signing in with a platform user account');
}

/**
 * The calling person as an {@link ActorIdentity}.
 *
 * `403` for a service caller or an anonymous request: a separation of duties is
 * between people. With `requirePlatformUserId`, also `403` for a token without
 * `rasta_uid` — the same refusal as `@RequirePlatformUserId()`, for a service
 * that asks in its domain layer as well as on the route.
 */
export function currentActor(options: { requirePlatformUserId?: boolean } = {}): ActorIdentity {
  const context = getContext();
  if (context.authType !== 'USER' || !context.userId) {
    throw RastaError.forbidden('Only a signed-in person may do this');
  }
  if (options.requirePlatformUserId === true && context.platformUserId !== true) {
    throw platformUserIdRequired();
  }
  return Object.freeze({
    userId: context.userId,
    issuer: present(context.issuer),
    subject: present(context.subject),
  });
}

/**
 * Whether `a` and `b` are one person, two, or cannot be told apart.
 *
 * **SAME** when any of these holds:
 *  - the user ids are equal;
 *  - both sides carry an issuer and subject, and the pairs are equal;
 *  - one side's user id is the other side's subject — a record written from a
 *    token without `rasta_uid`, whose user id *is* the subject.
 *
 * **DISTINCT** only when nothing above matched and both sides carry a user id,
 * an issuer and a subject. **UNKNOWN** otherwise.
 *
 * The comparison leans one way on purpose: a false SAME refuses a legitimate
 * second person, a false DISTINCT lets one person approve their own work. So
 * the subject-as-user-id match ignores the issuer (there is one issuer per
 * deployment), and blank values count as absent.
 */
export function compareActors(a: ActorIdentity, b: ActorIdentity): ActorComparison {
  const userA = present(a.userId);
  const userB = present(b.userId);
  const issuerA = present(a.issuer);
  const issuerB = present(b.issuer);
  const subjectA = present(a.subject);
  const subjectB = present(b.subject);

  if (userA !== null && userA === userB) return 'SAME';
  if (issuerA !== null && subjectA !== null && issuerA === issuerB && subjectA === subjectB) {
    return 'SAME';
  }
  if ((userA !== null && userA === subjectB) || (userB !== null && userB === subjectA)) {
    return 'SAME';
  }

  const known = (user: string | null, issuer: string | null, subject: string | null) =>
    user !== null && issuer !== null && subject !== null;
  return known(userA, issuerA, subjectA) && known(userB, issuerB, subjectB)
    ? 'DISTINCT'
    : 'UNKNOWN';
}

/** Fails closed: `true` unless `a` and `b` are **provably** two people. */
export function sameActor(a: ActorIdentity, b: ActorIdentity): boolean {
  return compareActors(a, b) !== 'DISTINCT';
}

/**
 * Refuses unless `a` and `b` are provably two people.
 *
 *   SAME     `403 FORBIDDEN`              "Separation of duties: <what>"
 *   UNKNOWN  `422 ACTOR_IDENTITY_UNKNOWN` separation cannot be proven
 *
 * `what` is the rule in the service's own words — static text, never a value
 * from the request or a record (S-09). A service whose rule already has its own
 * refusal code calls {@link compareActors} and maps the outcome itself; UNKNOWN
 * must still refuse.
 */
export function assertDistinctActors(a: ActorIdentity, b: ActorIdentity, what: string): void {
  const comparison = compareActors(a, b);
  if (comparison === 'DISTINCT') return;
  if (comparison === 'SAME') throw RastaError.forbidden(`Separation of duties: ${what}`);
  throw actorIdentityUnknown(what);
}

/** `422 ACTOR_IDENTITY_UNKNOWN`: the two actors of `what` cannot be told apart. */
export function actorIdentityUnknown(what: string): RastaError {
  return new RastaError(
    ERROR_CODES.ACTOR_IDENTITY_UNKNOWN,
    `Separation of duties cannot be proven, because a record names no stable identity: ${what}`,
  );
}

function present(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
