import type { Response } from 'express';
import { HealthController } from './health.controller';
import { SERVICE_NAME } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import type { DispatcherConsumer } from '../intake/dispatcher.consumer';
import type { ResolutionWorker } from '../resolution/resolution.worker';

function controller(state: { database: boolean; consumer: boolean; worker: boolean }) {
  const prisma = { isHealthy: async () => state.database } as unknown as PrismaService;
  const dispatcher = { isRunning: () => state.consumer } as unknown as DispatcherConsumer;
  const worker = { isRunning: () => state.worker } as unknown as ResolutionWorker;
  return new HealthController(prisma, dispatcher, worker);
}

function response(): Response & { statusCode?: number } {
  const res = { status: jest.fn() } as unknown as Response & { statusCode?: number };
  (res.status as jest.Mock).mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  return res;
}

describe('notification-service health probes', () => {
  it('reports the process as live and names itself', () => {
    const live = controller({ database: true, consumer: true, worker: true }).live();
    expect(live.status).toBe('ok');
    expect(live.service).toBe(SERVICE_NAME);
    expect(live.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('is ready only when the database, the consumer and the worker are all up', async () => {
    const res = response();
    const ready = await controller({ database: true, consumer: true, worker: true }).ready(res);

    expect(ready.status).toBe('ok');
    expect(ready.dependencies).toEqual({ database: true, consumer: true, worker: true });
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['database', { database: false, consumer: true, worker: true }],
    ['consumer', { database: true, consumer: false, worker: true }],
    ['worker', { database: true, consumer: true, worker: false }],
  ])('answers 503 when the %s is down, naming it', async (_name, state) => {
    const res = response();
    const ready = await controller(state).ready(res);

    expect(ready.status).toBe('unavailable');
    expect(ready.dependencies).toEqual(state);
    expect(res.statusCode).toBe(503);
  });

  it('states which channel it delivers on, and that email is not one of them', async () => {
    // No email has ever been sent from this platform and no provider has been
    // chosen (ADR-054 § 6, Q-37). The probe says so in the payload.
    const ready = await controller({ database: true, consumer: true, worker: true }).ready(
      response(),
    );
    expect(ready.channels).toEqual({ IN_APP: true, EMAIL: false });
    expect(ready.deliversMessages).toEqual({ IN_APP: true, EMAIL: false });
  });
});
