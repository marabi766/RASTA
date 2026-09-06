import { AsyncLocalStorage } from 'node:async_hooks';
import { RastaError } from '../errors/rasta-error';

/**
 * The identity and provenance of the work currently being done.
 *
 * This travels with a request across every async hop — HTTP handler, database
 * call, outbox row, Kafka envelope, Temporal workflow — so that one
 * correlationId links a browser click to a ledger entry, and so that no code
 * path can "forget" which tenant it is acting for.
 *
 * It is deliberately immutable. A mutable context is a context that some
 * middleware will eventually reassign mid-request, and tenant scoping derived
 * from a mutable value is not a security boundary.
 */
export interface RequestContext {
  /** Stable across the whole causal chain, including async fan-out. */
  readonly correlationId: string;
  /** Unique to this one inbound request. */
  readonly requestId: string;
  readonly traceId?: string;
  readonly spanId?: string;

  /**
   * The organization this request acts for. Every tenant-scoped query is
   * bounded by this value.
   *
   * Undefined only for anonymous requests and for platform-wide operations
   * performed by SYSTEM_ADMIN.
   */
  readonly organizationId?: string;

  /**
   * **Every** organization the verified token says this caller belongs to.
   *
   * `organizationId` above is the one they are *acting for* — chosen per
   * request, by the `X-Organization-Id` header, from this set. This is who they
   * *are*, which is not the same question and cannot be answered from the
   * selected tenant alone.
   *
   * The distinction is the D-2 security defect. supplier-service refuses to let
   * an organization decide its own qualification, and asked that question of
   * `organizationId`: a platform operator who belonged to both the union and a
   * supplier simply sent `X-Organization-Id: <the union>` and approved their own
   * submission. Every role check passed, every tenant check passed, and the one
   * control that existed to stop self-judgement was reading a field the caller
   * chooses.
   *
   * Populated from the token's own claims and frozen with the rest of the
   * context, so nothing downstream can add a membership the identity provider
   * did not assert. It always contains `organizationId` when there is one, so a
   * check written against this set can never be weaker than one written against
   * the selected tenant.
   *
   * **Empty is not "trusted".** A service token and an anonymous request both
   * carry no memberships; that means *unknown*, and a caller with no
   * memberships is refused authority by role checks, not granted it by this
   * field. Use {@link isMemberOfOrganization} to ask the question rather than
   * reading the array, so the union with `organizationId` is applied
   * consistently.
   */
  readonly organizationIds: readonly string[];

  /** The platform's user id — what domain rows reference. */
  readonly userId?: string;
  /** The identity provider's subject, kept for correlating with IdP logs. */
  readonly subject?: string;
  readonly roles: readonly string[];
  readonly authType: AuthType;
  /** For service-to-service calls: which service is calling. */
  readonly callerService?: string;

  readonly ip?: string;
  readonly userAgent?: string;
  readonly method?: string;
  readonly path?: string;
  readonly startedAt: number;
}

export type AuthType = 'USER' | 'SERVICE' | 'ANONYMOUS';

/**
 * The store holds a *holder*, not the context itself.
 *
 * Nest's pipeline establishes context in middleware — before the auth guard
 * has run — so the request begins as anonymous and is upgraded once the token
 * is verified. A holder lets that single, controlled upgrade happen while each
 * `RequestContext` value stays frozen: callers can never mutate the context
 * they were handed, and there is exactly one function that can replace it.
 */
interface ContextHolder {
  current: RequestContext;
}

const storage = new AsyncLocalStorage<ContextHolder>();

/** Runs `fn` with `context` visible to everything it awaits. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run({ current: freezeContext(context) }, fn);
}

/**
 * Freezes the context **and** its membership set.
 *
 * `Object.freeze` is shallow, so without this the array inside a frozen context
 * would still be mutable — and a membership set that downstream code can push
 * onto is not an authenticated fact, it is a suggestion. The array is copied
 * before freezing so a caller holding the original cannot mutate it afterwards
 * either.
 */
function freezeContext(context: RequestContext): RequestContext {
  return Object.freeze({
    ...context,
    organizationIds: Object.freeze([...(context.organizationIds ?? [])]),
  });
}

/**
 * Replaces the current context with an authenticated one.
 *
 * Called exactly once per request, by the auth guard, after the token has been
 * verified and the tenant resolved. Not exported from the package root: the
 * only legitimate caller lives inside this package.
 */
export function upgradeContext(patch: Partial<RequestContext>): RequestContext {
  const holder = storage.getStore();
  if (!holder) {
    throw new Error('upgradeContext() called outside a request context');
  }
  const next = freezeContext({ ...holder.current, ...patch });
  holder.current = next;
  return next;
}

/** The current context, or `undefined` outside a request (startup, cron, tests). */
export function tryGetContext(): RequestContext | undefined {
  return storage.getStore()?.current;
}

/**
 * The current context, throwing if absent.
 *
 * Use this where the absence of context is a bug rather than a valid state —
 * for example inside a tenant-scoped repository, where proceeding without a
 * context would mean running an unscoped query.
 */
export function getContext(): RequestContext {
  const context = storage.getStore()?.current;
  if (!context) {
    throw new Error(
      'No RequestContext available. This code path runs outside a request; ' +
        'either wrap it in runWithContext() or use tryGetContext() if that is expected.',
    );
  }
  return context;
}

/**
 * The organization this request acts for, throwing if there is none.
 *
 * This is the function tenant-scoped data access calls, and calling it is what
 * *makes* an operation tenant-scoped — there is no separate registry of which
 * endpoints are which, so the two can never drift apart.
 *
 * It throws rather than returning undefined precisely so that a missing tenant
 * becomes a loud failure instead of a query that quietly returns every
 * organization's rows. **Which** failure depends on who is calling:
 *
 *   SERVICE  a platform `403 SERVICE_TENANT_CONTEXT_INVALID`. The token was
 *            minted without a signed `org_id` and this operation needs one —
 *            a refusal, not a fault, and one the caller can act on by minting
 *            the right token (ADR-035). Reporting it as a 500, which is what
 *            happened before, made a deliberate security rule look like a bug
 *            and sent operators hunting for one.
 *
 *   USER     a raw Error, and therefore a 500. Here it genuinely is a bug: the
 *            auth guard resolves a tenant for every authenticated user, so
 *            arriving with none means an endpoint is tenant-scoped when it
 *            should not be, or is missing its guard entirely. That deserves to
 *            be as loud as possible.
 */
export function getOrganizationId(): string {
  const context = getContext();
  if (!context.organizationId) {
    if (context.authType === 'SERVICE') {
      throw RastaError.serviceTenantContextInvalid('MISSING_CLAIM', {
        callerService: context.callerService,
        path: context.path,
      });
    }
    throw new Error(
      `Request ${context.requestId} has no organizationId, but tenant-scoped data was accessed. ` +
        'This is a bug: either the endpoint should be tenant-scoped and is not, ' +
        'or it is a platform-wide operation and must use the explicit unscoped API.',
    );
  }
  return context.organizationId;
}

/**
 * Whether the caller belongs to `organizationId`, by any of their memberships.
 *
 * The question a conflict-of-interest rule must ask. Reading
 * `context.organizationId` answers "which hat are they wearing right now",
 * which the caller chooses per request; this answers "is this one of their
 * organizations at all", which the identity provider decided.
 *
 * The selected tenant is folded in as well as the membership set, so this can
 * never be weaker than the check it replaces even if a context is constructed
 * with an empty `organizationIds` — a background job, a consumer, an older
 * caller. Fail-closed by composition rather than by everyone remembering.
 *
 * An empty argument is not a match: "belongs to no organization" is not the
 * same as "belongs to this one", and returning true would turn an unknown into
 * a refusal for everybody.
 */
export function isMemberOfOrganization(
  organizationId: string | undefined,
  context: RequestContext | undefined = tryGetContext(),
): boolean {
  if (!organizationId || !context) return false;
  if (context.organizationId === organizationId) return true;
  return context.organizationIds.includes(organizationId);
}

export function hasRole(role: string): boolean {
  return tryGetContext()?.roles.includes(role) ?? false;
}

export function hasAnyRole(...roles: readonly string[]): boolean {
  const current = tryGetContext()?.roles;
  if (!current) return false;
  return roles.some((role) => current.includes(role));
}

/** The subset of context that belongs on every log line. */
export function toLogContext(context: RequestContext | undefined = tryGetContext()): {
  correlationId?: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  tenantId?: string;
  userId?: string;
} {
  if (!context) return {};
  return {
    correlationId: context.correlationId,
    requestId: context.requestId,
    traceId: context.traceId,
    spanId: context.spanId,
    tenantId: context.organizationId,
    userId: context.userId,
  };
}

/** Builds a context for background work — outbox relay, consumers, workflows. */
export function createSystemContext(
  overrides: Partial<RequestContext> & { correlationId: string },
): RequestContext {
  return {
    requestId: overrides.correlationId,
    roles: ['SYSTEM'],
    authType: 'SERVICE',
    // Background work belongs to no organization. Empty means *unknown*, and
    // `isMemberOfOrganization` therefore reports no membership — which is the
    // safe answer for a relay or a consumer, neither of which should ever be
    // deciding anybody's case.
    organizationIds: [],
    startedAt: Date.now(),
    ...overrides,
  };
}
