import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { GatewayHealthController } from '../app.module';
import { ProxyService } from '../proxy/proxy.service';
import { RateLimiter } from '../proxy/rate-limiter';
import { RevocationGate } from './revocation-gate';

/**
 * `/health/ready` with the revocation list (ADR-060, gateway revocation list addendum § 4): this
 * replica not caught up is unreadiness; a list every replica cannot vouch for is degradation.
 */

async function ready(gate: { isReady: boolean; refusing: boolean }, redis = true) {
  const controller = new GatewayHealthController(
    { isHealthy: async () => redis } as unknown as RateLimiter,
    { circuitStates: () => ({}) } as unknown as ProxyService,
    {
      isEnforcing: () => true,
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

describe('GatewayHealthController.ready with the list off: byte for byte what main answered (PR #381 r1 F4)', () => {
  // main (c018d3d4) `GatewayHealthController.ready`: these keys, in this order, and nothing else.
  const MAIN = {
    up: '{"status":"ok","service":"api-gateway","checks":{"redis":true},"degraded":[],"circuits":{}}',
    redisDown:
      '{"status":"ok","service":"api-gateway","checks":{"redis":false},"degraded":["rate-limiting"],"circuits":{}}',
  };

  let app: INestApplication;
  let redis = true;

  beforeAll(async () => {
    @Module({
      controllers: [GatewayHealthController],
      providers: [
        { provide: RateLimiter, useValue: { isHealthy: async () => redis } },
        { provide: ProxyService, useValue: { circuitStates: () => ({}) } },
        { provide: RevocationGate, useValue: RevocationGate.off() },
      ],
    })
    class HealthOnly {}
    app = await NestFactory.create(HealthOnly, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['Redis up', true, MAIN.up],
    ['Redis down', false, MAIN.redisDown],
  ])('%s: 200 and the same bytes, with no revocationList key', async (_label, healthy, bytes) => {
    redis = healthy;
    const response = await request(app.getHttpServer()).get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.text).toBe(bytes);
    expect(response.text).not.toContain('revocation');
  });
});
