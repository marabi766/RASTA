import type { RouteRule } from '../config/routes';
import type { RateLimitRule } from './rate-limiter';

/**
 * Whether a method only reads.
 *
 * One definition, used by both the idempotency requirement and the rate-limit
 * scoping, so the two cannot drift into disagreeing about what a write is.
 */
export function isSafeMethod(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

/** The rule a request is measured against, and the bucket it counts in. */
export interface SelectedRateLimit {
  /** The limiter's scope suffix: the route prefix, plus the operation when an override applies. */
  bucket: string;
  rule: RateLimitRule;
}

/**
 * Which rate limit a request under `route` counts against (task 130, PR #483
 * r1 R6).
 *
 * A route override applies to the operations its `appliesTo` names
 * (`RouteRule.rateLimit`); every other request under the prefix is on the
 * platform default. The two count in **separate buckets** — the override's is
 * named after its operation. They used to share one, keyed by prefix alone,
 * which was wrong both ways: the public registration submission's five an
 * hour also counted a reviewer's queue reads and decisions, so five page loads
 * locked the queue for an hour; and the limiter's sliding window trims a
 * bucket to the window of the rule it is consuming, so on `documents` one read
 * (a minute) discarded the hour of uploads the upload cap had counted.
 *
 * `path` is the request path without `/v1`, as `resolveRoute` reads it.
 */
export function rateLimitFor(
  route: RouteRule,
  method: string,
  path: string,
  platformDefault: RateLimitRule,
): SelectedRateLimit {
  const override = route.rateLimit;
  if (!override || !appliesTo(override.appliesTo, method, path)) {
    return { bucket: route.prefix, rule: platformDefault };
  }
  return {
    bucket: `${route.prefix}:${override.appliesTo ?? 'every-request'}`,
    rule: { limit: override.limit, windowSeconds: override.windowSeconds },
  };
}

function appliesTo(
  operations: NonNullable<RouteRule['rateLimit']>['appliesTo'],
  method: string,
  path: string,
): boolean {
  switch (operations) {
    case undefined:
      return true;
    case 'unsafe-methods':
      return !isSafeMethod(method);
    case 'collection-post':
      // The prefix's own segment and nothing after it (`/registration-requests`).
      return method.toUpperCase() === 'POST' && path.split('/').filter(Boolean).length === 1;
  }
}
