import { mayOffer, type DemoMode, type MoneyEffect } from '@/lib/demo-mode';

import { fetchDemoMode } from './demo-mode';
import type { WebSession } from './session';

/**
 * Whether a server action may send its command **now** (Q-14, review of PR 361
 * r4): the page's `mayOffer`, asked again when the form comes back, just
 * before the write.
 *
 * Drawing the form is not enough. A form drawn while the provider was known
 * carries a valid session, CSRF token, submission id and signed baseline long
 * after the provider stopped being readable, and posts as well as a fresh one;
 * only a read at submission time can refuse it. So every action whose command
 * `MONEY_EFFECTS` withholds calls this with that command's entry, and a
 * `false` means nothing is sent — the action answers `PROVIDER_UNKNOWN`.
 *
 * - `NONE` is sent without asking: a disclosure outage must not stop work that
 *   moves no money, and a read it does not need is one more thing that fails.
 * - Anything else is read again — by `readMode`, the same read the page drew
 *   the form from (`fetchDemoMode` unless the screen has its own) — and is sent
 *   only for an answer. A read that throws is `UNKNOWN` like any other failure,
 *   and so is an effect the table does not name (`mayOffer`).
 */
export async function mayDispatch(
  session: WebSession,
  effect: MoneyEffect | undefined,
  readMode: (session: WebSession) => Promise<DemoMode> = fetchDemoMode,
): Promise<boolean> {
  if (effect === 'NONE') return true;
  const mode = await readMode(session).catch((): DemoMode => 'UNKNOWN');
  return mayOffer(mode, effect);
}
