/**
 * Retry timing for recipient resolution when identity-service is away.
 *
 * The ladder is the platform's (`docs/07` § 7.6, ADR-054 § 7): 1s, 5s, 30s,
 * 2m, 10m — and then 10m again, for as long as it takes. An intent whose
 * recipients cannot be resolved is never given up on from this side: identity
 * being unreachable is an outage to wait out, not a reason to lose a
 * notification (ADR-054 § 1).
 *
 * Jitter is applied so a thousand intents deferred by one outage do not all
 * retry in the same second and turn the recovery into a second outage. The
 * draw is bounded to `[delay / 2, delay]` rather than `[0, delay]`: a resolution
 * retry that fires immediately after a refusal learns nothing new, and the
 * half-floor keeps every retry a real wait while still spreading the burst.
 */

const LADDER_SECONDS: readonly number[] = [1, 5, 30, 120, 600];

/** The delay before attempt `attemptsSoFar + 1`, in seconds, before jitter. */
export function baseDelaySeconds(attemptsSoFar: number, maxSeconds: number): number {
  const index = Math.min(Math.max(attemptsSoFar, 0), LADDER_SECONDS.length - 1);
  return Math.min(LADDER_SECONDS[index] as number, maxSeconds);
}

/** `random(delay / 2, delay)`, with the random source injectable for tests. */
export function jitteredDelaySeconds(
  attemptsSoFar: number,
  maxSeconds: number,
  random: () => number = Math.random,
): number {
  const base = baseDelaySeconds(attemptsSoFar, maxSeconds);
  const floor = base / 2;
  return floor + random() * (base - floor);
}

export function nextResolutionAt(
  attemptsSoFar: number,
  maxSeconds: number,
  now: Date = new Date(),
  random: () => number = Math.random,
): Date {
  return new Date(now.getTime() + jitteredDelaySeconds(attemptsSoFar, maxSeconds, random) * 1000);
}
