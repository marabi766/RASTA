import { z } from 'zod';
import type { DemoMode } from '@/lib/demo-mode';
import { callGateway } from './gateway';
import { webServerEnv } from './env';
import type { WebSession } from './session';

export type { DemoMode } from '@/lib/demo-mode';

/**
 * Whether the pilot's payment provider is simulated (Q-14): the one question
 * every screen that shows or moves money asks before it draws «حالت نمایشی».
 *
 * Asked of `GET /v1/wallets/provider/disclosure`, which economic-service
 * answers with `simulated` alone to any member of the organization — a
 * contractor reading its contract, a workshop its repair — rather than of the
 * administrators' `GET /v1/wallets/provider`, which would refuse most of the
 * people these screens are for. The answer is the provider's own flag, never a
 * constant.
 *
 * **A read that fails is not a "no".** A refusal, an outage, a timeout or an
 * answer of the wrong shape is `UNKNOWN`, and the screen says so and withholds
 * what moves money (`DemoModeNotice`, `mayOffer`): drawing nothing would
 * show the money as if it were real.
 */
export async function fetchDemoMode(session: WebSession): Promise<DemoMode> {
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path: '/v1/wallets/provider/disclosure',
      accessToken: session.accessToken,
    });
    const parsed = disclosureSchema.safeParse(response.data);
    return parsed.success ? (parsed.data.simulated ? 'SIMULATED' : 'REAL') : 'UNKNOWN';
  } catch {
    // Whatever failed — refused, unreachable, timed out, unreadable — the
    // flag is unknown; the page itself still renders.
    return 'UNKNOWN';
  }
}

const disclosureSchema = z.object({ simulated: z.boolean() });
