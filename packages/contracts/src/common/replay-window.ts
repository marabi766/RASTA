/**
 * The one number the project-create replay window rests on (PM decisions D-065, D-067).
 *
 * The portal sends `Idempotency-Replay-Deadline` = the instant its stamp was drawn plus its window;
 * construction-service REFUSES a deadline later than `claim time + TTL − B` (`shared/idempotency.ts`),
 * so an honest client must never send one. Neither side can read the other's configuration at
 * runtime, so both are tied to this constant and refuse to boot when their own settings break it:
 *
 *   portal   (`apps/web/src/server/env.ts`)       window + portal skew allowance           ≤ K
 *   service  (`config/env.ts`)                    TTL − B − service skew                   ≥ K
 *
 * where B = 2 · CONSTRUCTION_CLOCK_SKEW_SECONDS + 7 s. Together:
 *
 *   window + portalSkew + serviceSkew  ≤  K + serviceSkew  ≤  TTL − B
 *
 * which is exactly "the portal's deadline, read on the slowest legal service clock, is no later than
 * the service's limit on its fastest". Raising K needs both sides re-deployed with settings that
 * still satisfy it; lowering it can only make a boot refuse earlier.
 *
 * 3 300 s = 55 minutes. The defaults satisfy both sides with room: the portal's (1 h retention − 600 s
 * margin = 3 000 s, + 30 s skew allowance = 3 030 s, slack 270 s) and the service's (24 h: 86 303 s;
 * at its shortest legal retention, 1 h with the default skew: 3 600 − 67 − 30 = 3 503 s, slack 203 s).
 */
export const PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS = 3_300;

/**
 * The same bound for procurement-service's keyed commands (FU-156, PM decision D-125): the portal sends
 * `Idempotency-Replay-Deadline` on every demand command it re-sends, and procurement-service refuses a
 * deadline later than `claim time + TTL − B` (its `shared/idempotency.ts`). Both sides are tied to this
 * constant exactly as above, with B = 2 · PROCUREMENT_CLOCK_SKEW_SECONDS + 7 s:
 *
 *   portal   (`apps/web/src/server/env.ts`)       window + portal skew allowance           ≤ K
 *   service  (procurement `config/env.ts`)        TTL − B − service skew                   ≥ K
 *
 * 3 300 s, the same number: the portal's default (1 h − 600 s + 30 s = 3 030 s) and the service's
 * shortest legal retention (1 h with the default skew: 3 600 − 67 − 30 = 3 503 s) both fit.
 */
export const PROCUREMENT_MAX_REPLAY_WINDOW_SECONDS = 3_300;

/**
 * The same bound for inventory-service's keyed commands (FU-171, PM decision D-133): inventory-service
 * refuses a deadline later than `claim time + TTL − B` (its `shared/idempotency.ts`), with
 * B = 2 · INVENTORY_CLOCK_SKEW_SECONDS + 7 s, and refuses to boot unless TTL − B − service skew ≥ K
 * (`config/env.ts`). 3 300 s, the same number: its shortest legal retention, 1 h with the default skew,
 * leaves 3 503 s. The portal's side of the bound arrives with the portal sending the header.
 */
export const INVENTORY_MAX_REPLAY_WINDOW_SECONDS = 3_300;
