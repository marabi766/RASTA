/**
 * What a screen that shows or moves money knows about the payment provider
 * (Q-14), in three states rather than a yes/no.
 *
 * - `SIMULATED` — the provider says it moves no real money: «حالت نمایشی».
 * - `REAL` — the provider says it does: no label.
 * - `UNKNOWN` — it could not be asked, or its answer could not be read. Not a
 *   "no": the screen says it does not know, and withholds what moves money
 *   (`movesMoney`), as the wallet withholds its top-up form.
 */
export type DemoMode = 'SIMULATED' | 'REAL' | 'UNKNOWN';

/** Whether a screen may offer an action that moves money: not while the provider is unknown. */
export function movesMoney(mode: DemoMode): boolean {
  return mode !== 'UNKNOWN';
}

/**
 * The mode a read of the administrators' provider disclosure says — the
 * wallet's, which reads it anyway for the notice above its top-up form — by
 * `fetchDemoMode`'s rule: `UNKNOWN` for anything but an answer.
 */
export function demoModeOf(read: {
  readonly kind: string;
  readonly data?: { readonly simulated: boolean };
}): DemoMode {
  if (read.kind !== 'OK' || read.data === undefined) return 'UNKNOWN';
  return read.data.simulated ? 'SIMULATED' : 'REAL';
}
