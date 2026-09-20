import type { Response } from 'express';
import { HealthController } from './health.controller';
import { SERVICE_NAME } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import type { DispatcherConsumer } from '../intake/dispatcher.consumer';
import type { ResolutionWorker } from '../resolution/resolution.worker';
import type { MailChannel } from '../channels/mail.channel.port';

function controller(state: {
  database: boolean;
  consumer: boolean;
  worker: boolean;
  mailAvailable?: boolean;
}) {
  const prisma = { isHealthy: async () => state.database } as unknown as PrismaService;
  const dispatcher = { isRunning: () => state.consumer } as unknown as DispatcherConsumer;
  const worker = { isRunning: () => state.worker } as unknown as ResolutionWorker;
  const mail: MailChannel = {
    name: 'smtp',
    deliversToRealRecipients: false,
    send: async () => {
      throw new Error('the probe must not send anything');
    },
    health: async () => ({
      available: state.mailAvailable ?? true,
      channel: 'smtp',
      deliversToRealRecipients: false,
      detail: (state.mailAvailable ?? true) ? null : 'CONNECTION_FAILED',
    }),
  };
  return new HealthController(prisma, dispatcher, worker, mail);
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

  describe('the mail channel is reported, and reporting it is all it does', () => {
    it('says the adapter is reachable without claiming email is delivered', async () => {
      // The distinction Q-37 turns on. A reachable Mailpit is not a platform
      // that emails anybody: no rule produces an email delivery, and the
      // adapter says so itself.
      const ready = await controller({ database: true, consumer: true, worker: true }).ready(
        response(),
      );

      expect(ready.mailChannel).toEqual({
        available: true,
        channel: 'smtp',
        deliversToRealRecipients: false,
        detail: null,
      });
      expect(ready.deliversMessages.EMAIL).toBe(false);
    });

    it('stays ready when the mail server is unreachable', async () => {
      // Mailpit sits behind a compose profile `pnpm infra:up` does not start,
      // so depending on it would leave every default stack permanently
      // unready — and nothing sends email yet, so it costs nothing when it is
      // down. This is the same reasoning that keeps Kafka out of
      // `dependencies`.
      const res = response();
      const ready = await controller({
        database: true,
        consumer: true,
        worker: true,
        mailAvailable: false,
      }).ready(res);

      expect(ready.status).toBe('ok');
      expect(res.status).not.toHaveBeenCalled();
      expect(ready.mailChannel.available).toBe(false);
      expect(ready.mailChannel.detail).toBe('CONNECTION_FAILED');
    });
  });
});
