import { GatewayController } from './gateway.controller';
import { resolveRoute } from '../config/routes';
import { RevocationGate } from '../revocation/revocation-gate';
import type { ProxyService } from './proxy.service';
import type { RateLimiter } from './rate-limiter';
import type { GatewayEnv } from '../config/env';

/** An authenticated internal meter collection must never be reachable through the public gateway. */
it('does not route or forward the fleet internal usage collection or its sibling item read', async () => {
  const forward = jest.fn();
  const consume = jest.fn();
  const controller = new GatewayController(
    { forward } as unknown as ProxyService,
    { consume } as unknown as RateLimiter,
    {} as GatewayEnv,
    RevocationGate.off(),
  );
  for (const path of ['/v1/internal/usage-records', '/v1/internal/usage-records/USG_1']) {
    expect(resolveRoute(path.replace(/^\/v1/, ''))).toBeUndefined();
    await expect(
      controller.handle(
        {
          method: 'GET',
          path,
          originalUrl: `${path}?assetId=AST_1&cursor=opaque`,
          headers: { authorization: 'Bearer user', 'x-internal-token': 'internal' },
        } as never,
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }
  expect(forward).not.toHaveBeenCalled();
  expect(consume).not.toHaveBeenCalled();
});
