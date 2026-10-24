import { GatewayHealthController } from '../app.module';
import type { ProxyService } from '../proxy/proxy.service';
import type { RateLimiter } from '../proxy/rate-limiter';
import type { RevocationGate } from './revocation-gate';

/**
 * `/health/ready` with the revocation list (ADR-060, gateway revocation list addendum § 4): this
 * replica not caught up is unreadiness; a list every replica cannot vouch for is degradation.
 */

async function ready(gate: { isReady: boolean; refusing: boolean }, redis = true) {
  const controller = new GatewayHealthController(
    { isHealthy: async () => redis } as unknown as RateLimiter,
    { circuitStates: () => ({}) } as unknown as ProxyService,
    {
      isReady: () => gate.isReady,
      isRefusingEveryPair: () => gate.refusing,
    } as unknown as RevocationGate,
  );
  let status = 0;
  const body = await controller.ready({ status: (code: number) => (status = code) } as never);
  return { status, body };
}

describe('GatewayHealthController.ready and the revocation list', () => {
  it('is 503 while this replica has not caught up', async () => {
    const { status, body } = await ready({ isReady: false, refusing: true });
    expect(status).toBe(503);
    expect(body).toMatchObject({ status: 'unavailable', checks: { revocationList: false } });
  });

  it('is 200 and degraded while every pair is refused for a reason every replica shares', async () => {
    const { status, body } = await ready({ isReady: true, refusing: true }, false);
    expect(status).toBe(200);
    expect(body.degraded).toEqual(['rate-limiting', 'revocation-list']);
  });

  it('is 200 and not degraded when the list can be vouched for', async () => {
    const { status, body } = await ready({ isReady: true, refusing: false });
    expect(status).toBe(200);
    expect(body.degraded).toEqual([]);
  });
});
