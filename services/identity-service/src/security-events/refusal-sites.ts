import { ERROR_CODES, type ErrorCode } from '@rasta/contracts';
import type { RastaError } from '@rasta/nest-common';

/**
 * The refusals this service records as audit evidence (ADR-053 § 4,
 * AUD-004 Phase C1) — a fixed allowlist, and the only source of the audit
 * `action`, `resourceType` and `reason` those records carry.
 *
 * ## Why an allowlist, and why it is attached at the throw site
 *
 * An exception filter sees every error the service raises, and most of them are
 * not evidence: a `401` has no attributable actor, a `404` is not a refusal, and
 * the same `TENANT_MISMATCH` code is also raised by the auth guard for a bad
 * `X-Organization-Id` header — before any identity decision was made. Deciding
 * from the status code alone would record all of those, and deciding from the
 * URL would let a caller choose what the audit record says.
 *
 * So a refusal is recorded only when **the code that made the decision** marks
 * the error it throws with a site from this table, and the filter then checks
 * that the platform's final classification, the HTTP method and the matched
 * route template all agree with that site. Everything the record says about
 * *what* was refused comes from here; nothing comes from the path, the query
 * string or the body.
 *
 * Phase C1 instruments exactly one site. Every other `403` in this service —
 * and in every other service — is not recorded yet (ADR-053 plan § 8, R-2).
 */

/** Which trusted value names the refused resource. Never request input. */
export type RefusalResourceSource = 'ACTOR_USER';

export interface RefusalSite {
  /** Stable and bounded — safe in a log line. Never a metric label. */
  readonly key: string;
  readonly method: 'POST';
  /** The route template Express reports as `req.route.path`, version prefix included. */
  readonly route: string;
  readonly status: 403;
  readonly errorCode: ErrorCode;
  /** A dotted verb, as `auditActionSchema` requires. */
  readonly action: string;
  readonly resourceType: string;
  readonly resource: RefusalResourceSource;
  /** Fixed text. Never built from the request. */
  readonly reason: string;
}

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
    action: 'identity.active_organization.switch',
    resourceType: 'User',
    resource: 'ACTOR_USER',
    reason:
      'Active organization switch refused: no active membership in the requested organization',
  },
} as const satisfies Record<string, RefusalSite>;

export type RefusalSiteName = keyof typeof REFUSAL_SITES;

/**
 * Error → site. A `WeakMap` rather than a property on the error, so the thrown
 * value — its class, fields, message and serialisation — is exactly what it was
 * without the mark, and the platform filter's response cannot change.
 */
const marks = new WeakMap<object, RefusalSiteName>();

/** Marks `error` as a refusal from `site` and returns it unchanged, for `throw`. */
export function markRefusal<T extends RastaError>(error: T, site: RefusalSiteName): T {
  marks.set(error, site);
  return error;
}

/** The site an error was marked with, or `undefined` for every unmarked value. */
export function refusalSiteOf(error: unknown): RefusalSite | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const name = marks.get(error);
  return name === undefined ? undefined : REFUSAL_SITES[name];
}
