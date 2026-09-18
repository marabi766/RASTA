import { ERROR_CODES, type ErrorCode } from '@rasta/contracts';
import type { RastaError } from '@rasta/nest-common';

/**
 * The refusals this service records as audit evidence (ADR-053 § 4,
 * AUD-004 Phases C1–C11) — a fixed allowlist, and the only source of the audit
 * `action`, `resourceType` and `reason` those records carry.
 *
 * ## Why an allowlist, and why it is attached where the decision is made
 *
 * An exception filter sees every error the service raises, and most of them are
 * not evidence: a `401` has no attributable actor and a `404` is not a refusal.
 * The same `TENANT_MISMATCH` code is raised at two different decisions — by the
 * auth guard for a bad `X-Organization-Id` header, and by `IdentityService` for a
 * switch into an organization the caller holds no active membership in — and the
 * two are separate sites, with separate deciders and separate actions (Phase
 * C10). Deciding from the status code alone would record every refusal, and
 * deciding from the URL would let a caller choose what the audit record says.
 *
 * So a refusal is recorded only when **the code that made the decision** marks
 * the error it throws with a site from this table, and the filter then checks
 * that the platform's final classification, the HTTP method and the matched
 * route template all agree with that site. Everything the record says about
 * *what* was refused comes from here; nothing comes from the path, the query
 * string or the body.
 *
 * Three deciders may mark, each only its own sites (`decidedBy`):
 *
 *   IDENTITY_SERVICE  a domain decision in `IdentityService`, marked at the
 *                     throw site with `markRefusal`.
 *   ROLES_GUARD       a denial by the platform `RolesGuard`, marked by
 *                     `IdentityRolesGuard` after the shared guard decided —
 *                     the shared guard itself knows nothing of this table.
 *   AUTH_GUARD        the platform `AuthGuard`'s own refusals — a user token's
 *                     tenant mismatch and a verified service caller's
 *                     `FORBIDDEN` — marked through that guard's generic
 *                     observation seams (`auth-guard-refusal.ts`).
 *
 * ## Why the auth guard's sites are route-agnostic
 *
 * The two guard deciders differ in *when* they decide. A role denial happens on
 * a matched route, so its site names that route and the filter checks it. The
 * auth guard decides **before** any controller authorization, on every
 * authenticated request whatever it was aimed at, so no route identifies it —
 * pinning it to one would silently drop the same refusal made anywhere else.
 * Its sites therefore carry `method: null` and `route: null`, and the filter
 * skips the route check for them and for nothing else (`refusal-capture.ts`).
 *
 * That is only safe because such a site cannot be marked from request data:
 * `markGuardRefusal` demands a trusted actor and tenant that only the shared
 * guard's post-verification seam can supply, and a mark without them is never
 * captured.
 *
 * Ten sites are instrumented. Every other `403` in this service — and in every
 * other service — is not recorded yet (ADR-053 plan § 8, R-2).
 */

/**
 * Which trusted value names the refused resource. Never request input.
 *
 *   ACTOR_USER     the verified user's own id
 *   ACTOR_SERVICE  the verified calling service's name (Phase C11)
 *
 * It also fixes the kind of actor a site may be attributed to: a site whose
 * resource is the acting user is never recorded against a service, and the
 * reverse (`decideCapture`).
 */
export type RefusalResourceSource = 'ACTOR_USER' | 'ACTOR_SERVICE';

/** Who makes the refusal decision, and so who may mark it. */
export type RefusalDecider = 'IDENTITY_SERVICE' | 'ROLES_GUARD' | 'AUTH_GUARD';

interface RefusalSiteBase {
  /** Stable and bounded — safe in a log line. Never a metric label. */
  readonly key: string;
  readonly status: 403;
  readonly errorCode: ErrorCode;
  readonly decidedBy: RefusalDecider;
  /** A dotted verb, as `auditActionSchema` requires. */
  readonly action: string;
  readonly resourceType: string;
  readonly resource: RefusalResourceSource;
  /** Fixed text. Never built from the request. */
  readonly reason: string;
}

/** A refusal made on one matched route, and recorded only on that route. */
export interface RouteRefusalSite extends RefusalSiteBase {
  readonly decidedBy: 'IDENTITY_SERVICE' | 'ROLES_GUARD';
  /** Route sites read the upgraded request context, which only a user has here. */
  readonly resource: 'ACTOR_USER';
  readonly method: 'GET' | 'POST';
  /** The route template Express reports as `req.route.path`, version prefix included. */
  readonly route: string;
}

/**
 * A refusal made before routing matters, and recorded whatever the route was.
 *
 * `null` rather than a wildcard: there is no route to compare, and a wildcard
 * would read as "every route matches", which is a different and weaker claim.
 */
export interface GuardRefusalSite extends RefusalSiteBase {
  readonly decidedBy: 'AUTH_GUARD';
  readonly method: null;
  readonly route: null;
  /**
   * What happens when the trusted attribution carries no tenant at all.
   *
   *   SKIP      not recorded: such a refusal is not attributable
   *             (`AUTH_TENANT_MISMATCH`)
   *   PLATFORM  recorded as a platform row, `organizationId = null`
   *             (`SERVICE_CALLER_FORBIDDEN`, Q-55)
   *
   * Policy, not logic: a product-owner answer that changes it is a one-value
   * edit to the table below and nothing else.
   */
  readonly withoutTenant: 'SKIP' | 'PLATFORM';
}

export type RefusalSite = RouteRefusalSite | GuardRefusalSite;

export const REFUSAL_SITES = {
  /**
   * `POST /v1/users/me/active-organization` refused by
   * `IdentityService.switchActiveOrganization()` because the caller holds no
   * active membership in the organization they asked to act for.
   *
   * The refused resource is the caller's **own** user record — the row whose
   * `activeOrganizationId` the request tried to change — named by the verified
   * token. The organization they asked for is attacker-chosen input and is
   * deliberately not recorded anywhere.
   */
  SWITCH_ACTIVE_ORGANIZATION: {
    key: 'identity.switch_active_organization',
    method: 'POST',
    route: '/v1/users/me/active-organization',
    status: 403,
    errorCode: ERROR_CODES.TENANT_MISMATCH,
    decidedBy: 'IDENTITY_SERVICE',
    action: 'identity.active_organization.switch',
    resourceType: 'User',
    resource: 'ACTOR_USER',
    reason:
      'Active organization switch refused: no active membership in the requested organization',
  },

  /**
   * `GET /v1/users` refused by the platform `RolesGuard` because the caller
   * holds neither `ORGANIZATION_ADMIN` nor `UNION_ADMIN` (nor `SYSTEM_ADMIN`)
   * — AUD-004 Phase C3.
   *
   * A collection read has no single refused record, so the resource id is the
   * caller's own user id from the verified token — stable per actor, the Kafka
   * partition key, and never request input. Which roles the endpoint requires
   * and the error's internal context are deliberately not recorded; the query
   * string never reaches the capture at all. The action name is a Temporary
   * Decision (`docs/24-open-questions.md` Q-45): the repository documents no
   * canonical audit verb for listing users.
   */
  LIST_USERS: {
    key: 'identity.list_users',
    method: 'GET',
    route: '/v1/users',
    status: 403,
    errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
    decidedBy: 'ROLES_GUARD',
    action: 'identity.users.list',
    resourceType: 'User',
    resource: 'ACTOR_USER',
    reason: 'User listing refused: the caller holds none of the roles this endpoint requires',
  },

  /**
   * `POST /v1/users` refused by the platform `RolesGuard` because the caller
   * holds neither `ORGANIZATION_ADMIN` nor `UNION_ADMIN` (nor `SYSTEM_ADMIN`)
   * — AUD-004 Phase C4.
   *
   * A refused create has no created user, and the user the body describes is
   * attacker-chosen input, so the resource id is the caller's own user id from
   * the verified token — as for `LIST_USERS`. The guard refuses before the body
   * is parsed; nothing from it, nor the endpoint's required roles, nor the
   * error's internal context, is ever recorded. The action name is a Temporary
   * Decision (`docs/24-open-questions.md` Q-46).
   */
  CREATE_USER: {
    key: 'identity.create_user',
    method: 'POST',
    route: '/v1/users',
    status: 403,
    errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
    decidedBy: 'ROLES_GUARD',
    action: 'identity.users.create',
    resourceType: 'User',
    resource: 'ACTOR_USER',
    reason: 'User creation refused: the caller holds none of the roles this endpoint requires',
  },

  /**
   * `POST /v1/users/:id/memberships` refused by the platform `RolesGuard`
   * because the caller holds neither `ORGANIZATION_ADMIN` nor `UNION_ADMIN`
   * (nor `SYSTEM_ADMIN`) — AUD-004 Phase C5.
   *
   * The guard refuses before any membership exists and before the path id or
   * the body is read or validated; both are attacker-chosen. So the resource id
   * is the caller's own user id from the verified token, and neither the target
   * user in the path, the organization or roles in the body, the endpoint's
   * required roles nor the error's internal context is ever recorded. The
   * action name and resource type are a Temporary Decision
   * (`docs/24-open-questions.md` Q-47).
   */
  ADD_MEMBERSHIP: {
    key: 'identity.add_membership',
    method: 'POST',
    route: '/v1/users/:id/memberships',
    status: 403,
    errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
    decidedBy: 'ROLES_GUARD',
    action: 'identity.memberships.create',
    resourceType: 'Membership',
    resource: 'ACTOR_USER',
    reason:
      'Membership creation refused: the caller holds none of the roles this endpoint requires',
  },

  /**
   * `POST /v1/memberships/:id/roles` refused by the platform `RolesGuard`
   * because the caller holds neither `ORGANIZATION_ADMIN` nor `UNION_ADMIN`
   * (nor `SYSTEM_ADMIN`) — AUD-004 Phase C6.
   *
   * The guard refuses before the membership named in the path is looked up and
   * before the body is read or validated; the id and the roles asked for are
   * attacker-chosen, and the membership may not exist. So the resource id is
   * the caller's own user id from the verified token, and neither the path id,
   * the requested roles or stated reason in the body, the endpoint's required
   * roles nor the error's internal context is ever recorded. The action name
   * and resource type are a Temporary Decision (`docs/24-open-questions.md`
   * Q-48).
   */
  UPDATE_MEMBERSHIP_ROLES: {
    key: 'identity.update_membership_roles',
    method: 'POST',
    route: '/v1/memberships/:id/roles',
    status: 403,
    errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
    decidedBy: 'ROLES_GUARD',
    action: 'identity.memberships.roles.replace',
    resourceType: 'Membership',
    resource: 'ACTOR_USER',
    reason:
      'Membership role replacement refused: the caller holds none of the roles this endpoint requires',
  },

  /**
   * `POST /v1/memberships/:id/revoke` refused by the platform `RolesGuard`
   * because the caller holds neither `ORGANIZATION_ADMIN` nor `UNION_ADMIN`
   * (nor `SYSTEM_ADMIN`) — AUD-004 Phase C7.
   *
   * The guard refuses before the membership named in the path is looked up and
   * before the body is read or validated; the id and the stated reason are
   * attacker-chosen, and the membership may not exist. So the resource id is
   * the caller's own user id from the verified token, and neither the path id,
   * the body's reason, the endpoint's required roles nor the error's internal
   * context is ever recorded. The catalogue's `MEMBERSHIP_REVOKED` names a
   * revocation that *happened*, which is not the verb of a refused command, so
   * the action name and resource type are a Temporary Decision
   * (`docs/24-open-questions.md` Q-49).
   */
  REVOKE_MEMBERSHIP: {
    key: 'identity.revoke_membership',
    method: 'POST',
    route: '/v1/memberships/:id/revoke',
    status: 403,
    errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
    decidedBy: 'ROLES_GUARD',
    action: 'identity.memberships.revoke',
    resourceType: 'Membership',
    resource: 'ACTOR_USER',
    reason:
      'Membership revocation refused: the caller holds none of the roles this endpoint requires',
  },

  /**
   * `POST /v1/registration-requests/:id/approve` refused by the platform
   * `RolesGuard` because the caller does not hold `UNION_ADMIN` (nor
   * `SYSTEM_ADMIN`) — AUD-004 Phase C8.
   *
   * The first site whose endpoint requires a **single** role. Its sibling
   * `/reject` is a site of its own (Phase C9) with a distinct action, so the
   * two outcomes of one review never aggregate into one row.
   *
   * The guard refuses before the registration request named in the path is
   * looked up and before the body is read or validated; the id and everything
   * the approval body states are attacker-chosen, and the request may not
   * exist — so a refused approval has no reviewed registration. The resource id
   * is therefore the caller's own user id from the verified token, and neither
   * the path id, the approval body, the endpoint's required role nor the
   * error's internal context is ever recorded. The catalogue's
   * `REGISTRATION_APPROVED` names an approval that *happened*, which is not the
   * verb of a refused command, so the action name and resource type are a
   * Temporary Decision (`docs/24-open-questions.md` Q-50).
   */
  APPROVE_REGISTRATION_REQUEST: {
    key: 'identity.approve_registration_request',
    method: 'POST',
    route: '/v1/registration-requests/:id/approve',
    status: 403,
    errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
    decidedBy: 'ROLES_GUARD',
    action: 'identity.registration_requests.approve',
    resourceType: 'RegistrationRequest',
    resource: 'ACTOR_USER',
    reason:
      'Registration approval refused: the caller holds none of the roles this endpoint requires',
  },

  /**
   * `POST /v1/registration-requests/:id/reject` refused by the platform
   * `RolesGuard` because the caller does not hold `UNION_ADMIN` (nor
   * `SYSTEM_ADMIN`) — AUD-004 Phase C9, and the last `@Roles` route in this
   * service: with it, every role-guarded route is an allowlisted site.
   *
   * The guard refuses before the registration request named in the path is
   * looked up and before the body — the stated rejection reason included — is
   * read or validated; all of it is attacker-chosen, and the request may not
   * exist. So the resource id is the caller's own user id from the verified
   * token, and neither the path id, the reason, the endpoint's required role
   * nor the error's internal context is ever recorded. The catalogue's
   * `REGISTRATION_REJECTED` names a rejection that *happened*, which is not the
   * verb of a refused command, so the action name and resource type are a
   * Temporary Decision (`docs/24-open-questions.md` Q-51). The action differs
   * from `APPROVE_REGISTRATION_REQUEST`'s so the two never share a row.
   */
  REJECT_REGISTRATION_REQUEST: {
    key: 'identity.reject_registration_request',
    method: 'POST',
    route: '/v1/registration-requests/:id/reject',
    status: 403,
    errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
    decidedBy: 'ROLES_GUARD',
    action: 'identity.registration_requests.reject',
    resourceType: 'RegistrationRequest',
    resource: 'ACTOR_USER',
    reason:
      'Registration rejection refused: the caller holds none of the roles this endpoint requires',
  },

  /**
   * Any authenticated request refused by the platform `AuthGuard` with
   * `403 TENANT_MISMATCH`, because `X-Organization-Id` asked to act for an
   * organization outside the verified token's memberships — AUD-004 Phase C10,
   * and the first site decided by neither this service's domain nor the roles
   * guard.
   *
   * **Route-agnostic** (see the header). The guard refuses before any
   * controller authorization, so the refusal belongs to the caller and the
   * tenant they were acting for, not to the endpoint they happened to aim at.
   *
   * The organization is the verified token's **active** organization — the one
   * the caller legitimately acts for — never the rejected header, which is
   * attacker-chosen and recorded nowhere. A token with no active organization
   * is not captured at all rather than captured as platform-scoped: an
   * unattributable tenant probe must not be filed under "no tenant" beside
   * legitimate platform-wide work.
   *
   * The resource is the caller's own user record — the subject whose tenant
   * context the request tried to select. The action name and resource type are
   * a Temporary Decision (`docs/24-open-questions.md` Q-52).
   */
  AUTH_TENANT_MISMATCH: {
    key: 'identity.auth_tenant_mismatch',
    method: null,
    route: null,
    status: 403,
    errorCode: ERROR_CODES.TENANT_MISMATCH,
    decidedBy: 'AUTH_GUARD',
    action: 'identity.tenant_context.select',
    resourceType: 'User',
    resource: 'ACTOR_USER',
    withoutTenant: 'SKIP',
    reason:
      'Organization selection refused: the requested organization is outside the verified token memberships',
  },

  /**
   * Any request carrying a **verified** `SERVICE` internal token refused by the
   * platform `AuthGuard` with `403 FORBIDDEN` — the endpoint carries no
   * `@AllowService`, or its allowlist excludes the calling service — AUD-004
   * Phase C11, and the first site whose actor is a service.
   *
   * **Route-agnostic** for the same reason as `AUTH_TENANT_MISMATCH`: the guard
   * decides before any controller authorization. Both of the guard's
   * `FORBIDDEN` decisions are this one site, because both say the same thing —
   * this service may not call this endpoint — and neither the endpoint nor its
   * allowlist is recorded.
   *
   * The actor and the resource are the calling service, named by the token's
   * signed subject. The tenant is the token's **signed** `org_id`; a
   * platform-wide token with none is recorded as a platform row
   * (`withoutTenant: 'PLATFORM'`) — a verified service acting for no tenant is
   * a real, attributable platform context, unlike a user with no active
   * organization. The unsigned `X-Organization-Id` header is never read.
   * Attribution, action, resource type and reason are a Temporary Decision
   * (`docs/24-open-questions.md` Q-55).
   */
  SERVICE_CALLER_FORBIDDEN: {
    key: 'identity.service_caller_forbidden',
    method: null,
    route: null,
    status: 403,
    errorCode: ERROR_CODES.FORBIDDEN,
    decidedBy: 'AUTH_GUARD',
    action: 'identity.service_call.authorize',
    resourceType: 'Service',
    resource: 'ACTOR_SERVICE',
    withoutTenant: 'PLATFORM',
    reason: 'Service call refused: the verified calling service is not permitted on this endpoint',
  },
} as const satisfies Record<string, RefusalSite>;

export type RefusalSiteName = keyof typeof REFUSAL_SITES;

/** The sites a decider marks on a matched route. */
export type RouteRefusalSiteName = {
  [Name in RefusalSiteName]: (typeof REFUSAL_SITES)[Name]['decidedBy'] extends 'AUTH_GUARD'
    ? never
    : Name;
}[RefusalSiteName];

/** The sites the shared auth guard's seam marks, which need trusted attribution. */
export type GuardRefusalSiteName = Exclude<RefusalSiteName, RouteRefusalSiteName>;

/**
 * Who a guard refusal was decided against, taken from the shared guard's own
 * verified token — the only attribution a route-agnostic site has.
 *
 * Deliberately not the request context: when the auth guard refuses, the
 * context still says `ANONYMOUS`, because it is upgraded only after the guard
 * admits the request. Reading it there would file every such refusal as
 * unattributable; reading a header, or decoding the token again here, would
 * invent an actor this service never verified.
 *
 * Discriminated by the kind of verified token, because the two carry different
 * trusted facts: a user token has roles and an active organization; a service
 * token has a signed caller name and, optionally, a signed tenant.
 */
export type TrustedRefusalAttribution = TrustedUserAttribution | TrustedServiceAttribution;

export interface TrustedUserAttribution {
  readonly actorType: 'USER';
  readonly userId: string;
  /** The verified token's active organization. Never the rejected header. */
  readonly organizationId: string;
  readonly roles: readonly string[];
}

export interface TrustedServiceAttribution {
  readonly actorType: 'SERVICE';
  /** The verified internal token's signed subject. */
  readonly callerService: string;
  /**
   * The verified internal token's signed `org_id`, or `null` for a
   * platform-wide token. Never the unsigned `X-Organization-Id` header.
   */
  readonly organizationId: string | null;
}

/** The attribution a guard site demands, by the kind of actor it records. */
export type AttributionFor<Name extends GuardRefusalSiteName> =
  (typeof REFUSAL_SITES)[Name]['resource'] extends 'ACTOR_SERVICE'
    ? TrustedServiceAttribution
    : TrustedUserAttribution;

/**
 * Error → site. A `WeakMap` rather than a property on the error, so the thrown
 * value — its class, fields, message and serialisation — is exactly what it was
 * without the mark, and the platform filter's response cannot change.
 */
const marks = new WeakMap<object, RefusalSiteName>();

/** Attribution for the sites that have no request context to read one from. */
const attributions = new WeakMap<object, TrustedRefusalAttribution>();

/** Marks `error` as a refusal from `site` and returns it unchanged, for `throw`. */
export function markRefusal<T extends RastaError>(error: T, site: RouteRefusalSiteName): T {
  marks.set(error, site);
  return error;
}

/**
 * Marks a guard refusal, with the trusted actor and tenant it was decided
 * against. Returns the error unchanged, exactly as `markRefusal` does.
 *
 * Separate from `markRefusal`, and the only way to mark a route-agnostic site,
 * so that "recorded without a route" and "recorded without trusted
 * attribution" cannot come apart: the type system demands the attribution
 * here, and `decideCapture` refuses such a site without it.
 *
 * An error already marked is left alone. One refusal is one decision, and the
 * decider that marked it first is the one that made it.
 */
export function markGuardRefusal<T extends RastaError, Name extends GuardRefusalSiteName>(
  error: T,
  site: Name,
  attribution: AttributionFor<Name>,
): T {
  if (marks.has(error)) return error;
  marks.set(error, site);
  attributions.set(error, frozenCopyOf(attribution));
  return error;
}

/** A frozen copy, so nothing the marker still holds can rewrite evidence. */
function frozenCopyOf(attribution: TrustedRefusalAttribution): TrustedRefusalAttribution {
  if (attribution.actorType === 'SERVICE') {
    return Object.freeze({
      actorType: 'SERVICE',
      callerService: attribution.callerService,
      organizationId: attribution.organizationId,
    });
  }
  return Object.freeze({
    actorType: 'USER',
    userId: attribution.userId,
    organizationId: attribution.organizationId,
    roles: Object.freeze([...attribution.roles]),
  });
}

/** The trusted attribution a guard refusal was marked with, if it was. */
export function trustedAttributionOf(error: unknown): TrustedRefusalAttribution | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return attributions.get(error);
}

/** The site an error was marked with, or `undefined` for every unmarked value. */
export function refusalSiteOf(error: unknown): RefusalSite | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const name = marks.get(error);
  return name === undefined ? undefined : REFUSAL_SITES[name];
}

/**
 * The roles-guard site allowlisted for exactly this matched method and route
 * template, if there is one. Both values are Express's own — `req.method` and
 * `req.route.path`, the template, never the concrete URL — so a caller cannot
 * steer it with a path or a query string.
 */
export function rolesGuardSiteFor(
  method: unknown,
  route: unknown,
): RouteRefusalSiteName | undefined {
  if (typeof method !== 'string' || typeof route !== 'string') return undefined;
  for (const [name, site] of Object.entries(REFUSAL_SITES) as [RefusalSiteName, RefusalSite][]) {
    if (
      site.decidedBy === 'ROLES_GUARD' &&
      site.method === method &&
      site.route === route &&
      isRouteSiteName(name)
    ) {
      return name;
    }
  }
  return undefined;
}

/**
 * Whether a site name is one of the route-bound ones — the same question
 * `RouteRefusalSiteName` asks of the table, asked of a value.
 *
 * A predicate rather than a cast, so that adding a second route-agnostic site
 * cannot quietly widen what `markRefusal` accepts.
 */
function isRouteSiteName(name: RefusalSiteName): name is RouteRefusalSiteName {
  return REFUSAL_SITES[name].decidedBy !== 'AUTH_GUARD';
}
