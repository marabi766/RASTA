import 'reflect-metadata';
import {
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { installGracefulShutdown, type ShutdownSignalSource } from './graceful-shutdown';

/**
 * The claim `installGracefulShutdown` rests on, against a real Nest
 * application: `app.close()` runs every lifecycle hook *without*
 * `enableShutdownHooks()`, and the exit waits for the slowest of them.
 *
 * The slow `onApplicationShutdown` stands in for what the old competing
 * handler cut off — an outbox relay draining its batch, a consumer finishing a
 * message, a sweeper finishing a scan.
 */
const events: string[] = [];
const DRAIN_MS = 300;

@Injectable()
class DrainingWorker implements OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  onModuleDestroy(): void {
    events.push('onModuleDestroy');
  }
  beforeApplicationShutdown(signal?: string): void {
    events.push(`beforeApplicationShutdown:${signal}`);
  }
  async onApplicationShutdown(signal?: string): Promise<void> {
    events.push(`onApplicationShutdown:${signal}:start`);
    await new Promise((resolve) => setTimeout(resolve, DRAIN_MS));
    events.push('onApplicationShutdown:drained');
  }
}

@Module({ providers: [DrainingWorker] })
class AppModule {}

class FakeSignals implements ShutdownSignalSource {
  private readonly listeners = new Map<NodeJS.Signals, () => void>();
  on(signal: NodeJS.Signals, listener: () => void): this {
    this.listeners.set(signal, listener);
    return this;
  }
  emit(signal: NodeJS.Signals): void {
    this.listeners.get(signal)?.();
  }
}

describe('installGracefulShutdown against a real Nest application', () => {
  beforeEach(() => {
    events.length = 0;
  });

  it('runs every lifecycle hook, waits for a slow one, flushes, then exits 0', async () => {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    const signals = new FakeSignals();
    const exit = jest.fn((code: number) => {
      events.push(`exit:${code}`);
    });

    // Deliberately no `app.enableShutdownHooks()`.
    installGracefulShutdown(app, {
      serviceName: 'nest-test',
      timeoutMs: 5_000,
      afterClose: async () => {
        events.push('afterClose');
      },
      logger: { warn: jest.fn(), error: jest.fn() },
      exit,
      signalSource: signals,
    });

    signals.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, DRAIN_MS / 2));
    expect(exit).not.toHaveBeenCalled();
    expect(events).toEqual([
      'onModuleDestroy',
      'beforeApplicationShutdown:SIGTERM',
      'onApplicationShutdown:SIGTERM:start',
    ]);

    await new Promise((resolve) => setTimeout(resolve, DRAIN_MS));
    expect(events).toEqual([
      'onModuleDestroy',
      'beforeApplicationShutdown:SIGTERM',
      'onApplicationShutdown:SIGTERM:start',
      'onApplicationShutdown:drained',
      'afterClose',
      'exit:0',
    ]);
  });
});
