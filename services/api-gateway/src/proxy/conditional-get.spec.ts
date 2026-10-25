import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { ExpressAdapter } from '@nestjs/platform-express';
import request from 'supertest';
import type { Request, Response } from 'express';
import { InternalTokenService, runWithContext } from '@rasta/nest-common';
import { ProxyService } from './proxy.service';
import { GatewayController } from './gateway.controller';
import type { RateLimiter } from './rate-limiter';

// Real Express res.json, with its default weak ETag and freshness handling, behind
// the real gateway controller/proxy. No mocked fetch or fabricated 304 response.
describe('gateway conditional GET against Express', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['*', 'etag'])(
    '%s revalidation relays 304, clears failures and never opens the shared service breaker',
    async (validator) => {
      const upstream = new ExpressAdapter().getInstance();
      const observed: {
        cacheControl: string | undefined;
        validator: string | undefined;
        status: number;
        etag: unknown;
      }[] = [];
      upstream.get('/v1/users/me', (req: Request, res: Response) => {
        res.on('finish', () =>
          observed.push({
            cacheControl: req.headers['cache-control'],
            validator: req.headers['if-none-match'],
            status: res.statusCode,
            etag: res.getHeader('etag'),
          }),
        );
        if (req.headers['x-test-failure'])
          res.status(503).json({ code: 'INTERNAL_ERROR', message: 'fixture down' });
        else res.json({ id: 'USR_REVALIDATE' });
      });
      const owner = createServer(upstream);
      servers.push(owner);
      await new Promise<void>((resolve) => owner.listen(0, '127.0.0.1', resolve));
      const proxy = new ProxyService(
        {
          IDENTITY_SERVICE_URL: `http://127.0.0.1:${(owner.address() as AddressInfo).port}`,
        } as never,
        new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300),
        { timeoutMs: 2000, failureThreshold: 3, resetAfterMs: 60000 },
      );
      const controller = new GatewayController(
        proxy,
        {
          consume: async () => ({ allowed: true, limit: 100, remaining: 99, resetAt: 0 }),
        } as unknown as RateLimiter,
        {
          GATEWAY_RATE_LIMIT_MAX: 100,
          GATEWAY_RATE_LIMIT_WINDOW_MS: 60000,
          GATEWAY_TENANT_RATE_LIMIT_MAX: 100,
        } as never,
      );
      const edge = new ExpressAdapter().getInstance();
      edge.get('/v1/users/me', (req: Request, res: Response) => {
        void runWithContext(
          {
            correlationId: 'COR_CONDITIONAL',
            requestId: 'REQ_CONDITIONAL',
            startedAt: Date.now(),
            authType: 'USER',
            userId: 'USR_REVALIDATE',
            roles: [],
            organizationId: String(req.headers['x-organization-id']),
            organizationIds: [],
          },
          () => controller.handle(req, res),
        ).catch(() => res.status(503).end());
      });
      const gateway = createServer(edge);
      servers.push(gateway);
      await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
      const first = await request(gateway).get('/v1/users/me').set('x-organization-id', 'ORG_A');
      expect(first.status).toBe(200);
      expect(first.headers.etag).toMatch(/^W\//);
      expect(first.headers['cache-control']).toBeUndefined();
      const etag = String(first.headers.etag);
      const noCache = await request(gateway)
        .get('/v1/users/me')
        .set('x-organization-id', 'ORG_A')
        .set('if-none-match', validator === '*' ? '*' : etag);
      // The gateway Express response can itself revalidate the relayed 200.
      expect(noCache.status).toBe(304);
      expect(observed.at(-1)).toEqual({
        cacheControl: 'no-cache',
        validator: validator === '*' ? '*' : etag,
        status: 200,
        etag,
      });
      await request(gateway)
        .get('/v1/users/me')
        .set('x-test-failure', '1')
        .set('x-organization-id', 'ORG_A');
      expect(proxy.circuitStates().identity).toEqual({ failures: 1, open: false });
      for (let i = 0; i < 8; i += 1) {
        const answer = await request(gateway)
          .get('/v1/users/me')
          .set('x-organization-id', i % 2 === 0 ? 'ORG_A' : 'ORG_B')
          .set('if-none-match', validator === '*' ? '*' : etag)
          // Node fetch otherwise inserts cache-control:no-cache for conditional
          // requests, which makes Express answer 200. This caller header is forwarded.
          .set('cache-control', 'max-age=0');
        expect(observed.at(-1)).toEqual({
          cacheControl: 'max-age=0',
          validator: validator === '*' ? '*' : etag,
          status: 304,
          etag,
        });
        expect(answer.status).toBe(304);
        expect(answer.headers.etag).toBe(etag);
        expect(answer.text).toBe('');
        expect(proxy.circuitStates().identity).toEqual({ failures: 0, open: false });
      }
      // The circuit is shared across tenants inside this one proxy instance.
      expect(
        (await request(gateway).get('/v1/users/me').set('x-organization-id', 'ORG_B')).status,
      ).toBe(200);
    },
  );
});
