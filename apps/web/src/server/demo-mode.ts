import { fetchPaymentProvider } from './wallet';
import type { WebSession } from './session';

/**
 * Whether the pilot's payment provider is simulated (Q-14): the one question
 * every screen that shows or moves money asks before it draws «حالت نمایشی».
 *
 * The answer is the provider's own `simulated` flag, the source the wallet
 * screen already uses — never a constant. A read that fails is not a "no": the
 * flag is unknown, so the label is simply not drawn, and the screen's money
 * is unchanged either way.
 */
export async function fetchDemoMode(session: WebSession): Promise<boolean> {
  const provider = await fetchPaymentProvider(session);
  return provider.kind === 'OK' && provider.data.simulated;
}
