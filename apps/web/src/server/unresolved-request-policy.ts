/**
 * What every unresolved-request purpose is allowed to do, and the one time
 * budget the replay deadlines rest on. Pure constants and two small functions:
 * `env.ts` (boot check), `gateway.ts` (request timeout), the store and its
 * scripts all read this file, so there is one number for each thing.
 *
 * ## The purpose table (one place; the scripts receive it with every call)
 *
 * | purpose          | retry | deadline   | stored as                         |
 * | ---------------- | ----- | ---------- | --------------------------------- |
 * | `project-create` | true  | `REQUIRED` | a finite integer (ms since epoch) |
 *
 *   - `retry` — may an unresolved record with the very same key and body be
 *     sent again. True only where the service answers a repeated key with the
 *     first result **while it keeps the key**.
 *   - `deadline: 'REQUIRED'` — the record carries a finite numeric deadline, the
 *     last instant the key may be sent. Absence, `null` or a non-number is a
 *     **malformed record**, never "no limit".
 *   - `deadline: 'NONE'` — the service has no limit; stored explicitly as the
 *     string `"NONE"`, never by omitting the field. Allowed only for
 *     `retry: false` purposes (a purpose that resends must have a deadline).
 *
 * A purpose that is not in the table is refused (fail closed). Supplier
 * purposes (#366) add their own rows: `retry: false, deadline: 'NONE'`.
 *
 * ## Who guarantees what (PM decision D-065)
 *
 * Timing can never be closed in the portal alone: a clock jump, a paused process or a replica
 * of the service a minute off all sit between this portal's clocks and the one that expires the
 * service's idempotency key. So **the owning service is the guarantee**:
 * `construction-service` compares the replay deadline this portal sends
 * (`Idempotency-Replay-Deadline`) with the same clock that expires its key, and refuses a later
 * attempt of the same request with `409 REPLAY_WINDOW_CLOSED` before it writes anything
 * (`services/construction-service/src/shared/idempotency.ts`). Everything below — the skew
 * rule, the margin, the re-check before the dispatch — is **UX**: it stops the portal offering
 * a send the service would refuse, and it must never be read as the safety argument. Two further
 * rules close the portal's own side of the class:
 *
 *   - every refusal (the service's, and this portal's pre-dispatch re-check) proves only that
 *     THIS attempt did not execute: a request that was unresolved stays unresolved;
 *   - time never releases a hold: a reservation whose dispatcher did not settle it becomes
 *     `UNRESOLVED` when its lease ages, never free (`unresolved-request-store.ts`).
 *
 * ## Clocks: one budget, end to end
 *
 * Four clocks take part: the web replica that signs the stamp (the *issuer*),
 * the web replica that dispatches, Redis (`TIME`, the only clock the store's
 * scripts read), and construction-service (it expires the backend key on its
 * own clock). Every decision about a lease, a release, a reservation's age, a
 * pruned index entry or a TTL uses **Redis `TIME`**; no replica's clock enters
 * those. The only app-clock instants are the stamp's `issuedAt`/`deadline`, and
 * they are compared with Redis `TIME` like this:
 *
 *   send allowed  ⇔  redisNow + MAX_CLOCK_SKEW_MS ≤ deadline
 *
 * i.e. the deadline is moved **earlier** by one skew budget before comparing, on
 * the fresh path and on every retry, atomically in the script. Skew in either
 * direction can therefore only make the window shorter than configured or leave
 * it within the margin below, never longer.
 *
 * With `|clock − true time| ≤ MAX_CLOCK_SKEW_MS` for each of the issuer, Redis
 * and construction-service, the stamp deadline is `issue + (TTL − margin)` on
 * the issuer's clock, so in true time the last allowed dispatch is at most
 * `issue + TTL − margin + 2·skew − skew` (issuer vs Redis, less the check
 * margin), it needs up to `MAX_REQUEST_TIMEOUT_MS` to arrive, and the backend
 * key is gone no earlier than `claim + TTL − skew` (its clock). Nothing is
 * resent after the key is gone when
 *
 *     WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS · 1000
 *         ≥ 2 · MAX_CLOCK_SKEW_MS + MAX_REQUEST_TIMEOUT_MS
 *
 * and the portal **refuses to start** otherwise (`env.ts`, fail closed). Beyond
 * `MAX_CLOCK_SKEW_MS` of drift (NTP down) the guarantee is void: operations
 * must alarm on clock offset above half the budget.
 */

/** Largest tolerated offset of any one clock from true time (issuer, Redis, construction-service). */
export const MAX_CLOCK_SKEW_MS = 30_000;

/** Longest a dispatch may take to reach the service: the gateway timeout (`gateway.ts` uses this number). */
export const MAX_REQUEST_TIMEOUT_MS = 15_000;

/** The smallest replay margin (ms) the boot check accepts. */
export const MIN_REPLAY_MARGIN_MS = 2 * MAX_CLOCK_SKEW_MS + MAX_REQUEST_TIMEOUT_MS;

/**
 * The scopes a legacy (`v: 1`) record could have been written for: the first Redis version only ever
 * held project creates, with no target. A legacy record names no login of its own, so the only proof
 * that one belongs to the caller is its `bind` equalling the one the caller's session derives for one
 * of these scopes (`unresolved-request.ts` `purgeUnresolved`). One list, so adding a purpose to the
 * table does not silently widen what a purge may delete.
 */
export const LEGACY_V1_SCOPES: readonly { readonly purpose: string; readonly target?: string }[] = [
  { purpose: 'project-create' },
];

export type DeadlineMode = 'REQUIRED' | 'NONE';

export interface PurposePolicy {
  readonly retry: boolean;
  readonly deadline: DeadlineMode;
}

const PURPOSES: Readonly<Record<string, PurposePolicy>> = {
  'project-create': { retry: true, deadline: 'REQUIRED' },
};

/** The table, as the scripts receive it. A function so a test can stand in extra purposes. */
export function purposePolicies(): Readonly<Record<string, PurposePolicy>> {
  return PURPOSES;
}

/** The policy of `purpose`, or null when the table does not know it or breaks its own rule. */
export function policyOf(purpose: string): PurposePolicy | null {
  const policy = Object.hasOwn(purposePolicies(), purpose) ? purposePolicies()[purpose] : undefined;
  if (!policy) return null;
  // A purpose that resends must have a finite deadline.
  if (policy.retry && policy.deadline !== 'REQUIRED') return null;
  return policy;
}

/** Whether the replay margin (seconds) covers the clock budget; the boot check. */
export function replayMarginCoversClockBudget(marginSeconds: number): boolean {
  return marginSeconds * 1000 >= MIN_REPLAY_MARGIN_MS;
}
