import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from '@rasta/config';
import {
  DEFAULT_AFTER_CLOSE_TIMEOUT_MS,
  installGracefulShutdown,
  type GracefulShutdownOptions,
  type ShutdownLogger,
  type ShutdownSignalSource,
  type ShutdownTarget,
} from './graceful-shutdown';

/** A process stand-in: signals are emitted by the test, never sent to the runner. */
class FakeSignals implements ShutdownSignalSource {
  readonly listeners = new Map<NodeJS.Signals, () => void>();
  on(signal: NodeJS.Signals, listener: () => void): this {
    this.listeners.set(signal, listener);
    return this;
  }
  emit(signal: NodeJS.Signals): void {
    this.listeners.get(signal)?.();
  }
}

function harness(
  closeImpl: (signal?: string) => Promise<void>,
  extra: Partial<GracefulShutdownOptions> = {},
) {
  const calls: string[] = [];
  const signals = new FakeSignals();
  const logger: ShutdownLogger & { warn: jest.Mock; error: jest.Mock } = {
    warn: jest.fn(),
    error: jest.fn(),
  };
  const close = jest.fn((signal?: string) => {
    calls.push('close');
    return closeImpl(signal);
  });
  const app: ShutdownTarget = { close };
  const exit = jest.fn((code: number) => {
    calls.push(`exit:${code}`);
  });
  const afterClose = jest.fn(async () => {
    calls.push('afterClose');
  });
  const handle = installGracefulShutdown(app, {
    serviceName: 'test-service',
    timeoutMs: 1000,
    afterClose,
    logger,
    exit,
    signalSource: signals,
    ...extra,
  });
  return { calls, signals, logger, close, exit, afterClose, handle };
}

describe('installGracefulShutdown', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('waits for a slow close, then runs afterClose, then exits 0', async () => {
    const h = harness(() => new Promise((resolve) => setTimeout(resolve, 600)));

    h.signals.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(599);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.afterClose).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual(['close', 'afterClose', 'exit:0']);
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('exits 1 after the timeout when close hangs, and still flushes afterClose', async () => {
    const h = harness(() => new Promise<void>(() => undefined));

    h.signals.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(999);
    expect(h.exit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual(['close', 'afterClose', 'exit:1']);
    expect(h.logger.error).toHaveBeenCalledWith('[test-service] shutdown timed out after 1000 ms');
  });

  it('exits 1 when close throws, logging the error itself', async () => {
    const boom = new Error('relay batch failed');
    const h = harness(() => Promise.reject(boom));

    h.signals.emit('SIGINT');
    await jest.advanceTimersByTimeAsync(0);

    expect(h.calls).toEqual(['close', 'afterClose', 'exit:1']);
    expect(h.logger.error).toHaveBeenCalledWith('[test-service] error while closing', boom);
  });

  it('treats a synchronous throw from close as a failed close, not an exception', async () => {
    const h = harness(() => {
      throw new Error('sync');
    });

    h.signals.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(0);

    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('ignores a second signal: one close, one afterClose, one exit', async () => {
    const h = harness(() => new Promise((resolve) => setTimeout(resolve, 500)));

    h.signals.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(100);
    h.signals.emit('SIGINT');
    h.signals.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(400);

    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.afterClose).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.logger.warn).toHaveBeenCalledWith(
      '[test-service] already shutting down, ignoring SIGINT',
    );
  });

  it('returns the same promise to a repeated direct call', async () => {
    const h = harness(() => Promise.resolve());

    const first = h.handle.shutdown('SIGTERM');
    const second = h.handle.shutdown('SIGTERM');
    await jest.advanceTimersByTimeAsync(0);

    expect(second).toBe(first);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('passes the signal to close, as Nest passes it to onApplicationShutdown', async () => {
    const h = harness(() => Promise.resolve());

    h.signals.emit('SIGINT');
    await jest.advanceTimersByTimeAsync(0);

    expect(h.close).toHaveBeenCalledWith('SIGINT');
  });

  it('still exits 0 when afterClose fails: the application did close', async () => {
    const boom = new Error('collector down');
    const h = harness(() => Promise.resolve(), { afterClose: () => Promise.reject(boom) });

    h.signals.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(0);

    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.logger.error).toHaveBeenCalledWith('[test-service] error after closing', boom);
  });

  it('bounds afterClose on its own clock and still exits 0', async () => {
    const h = harness(() => Promise.resolve(), {
      afterClose: () => new Promise<void>(() => undefined),
      afterCloseTimeoutMs: 200,
    });

    h.signals.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(199);
    expect(h.exit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.logger.error).toHaveBeenCalledWith(
      '[test-service] post-close step timed out after 200 ms',
    );
  });

  it('works without afterClose', async () => {
    const h = harness(() => Promise.resolve(), { afterClose: undefined });

    h.signals.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(0);

    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('does not let a close that fails after the timeout become an unhandled rejection', async () => {
    let fail: (error: Error) => void = () => undefined;
    const h = harness(() => new Promise<void>((_resolve, reject) => (fail = reject)));

    h.signals.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(1000);
    expect(h.exit).toHaveBeenCalledWith(1);

    fail(new Error('late failure'));
    await jest.advanceTimersByTimeAsync(0);

    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it('uses the shared default when no timeout is given', async () => {
    const h = harness(() => new Promise<void>(() => undefined), { timeoutMs: undefined });

    h.signals.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(DEFAULT_SHUTDOWN_TIMEOUT_MS - 1);
    expect(h.exit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('keeps both default bounds inside a 30 s orchestrator grace period', () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS + DEFAULT_AFTER_CLOSE_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it('listens on SIGTERM and SIGINT by default, and nothing else', () => {
    const h = harness(() => Promise.resolve());

    expect([...h.signals.listeners.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('listens on exactly the signals it is given', () => {
    const h = harness(() => Promise.resolve(), { signals: ['SIGHUP'] });

    expect([...h.signals.listeners.keys()]).toEqual(['SIGHUP']);
  });

  it('logs the received signal with the service name', async () => {
    const h = harness(() => Promise.resolve());

    h.signals.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(0);

    expect(h.logger.warn).toHaveBeenCalledWith('[test-service] received SIGTERM, shutting down');
  });

  it('refuses a second install on the same process: that would be a second path', () => {
    const signals = new FakeSignals();
    const app: ShutdownTarget = { close: () => Promise.resolve() };
    installGracefulShutdown(app, { serviceName: 'svc', signalSource: signals });

    expect(() =>
      installGracefulShutdown(app, { serviceName: 'svc', signalSource: signals }),
    ).toThrow(/already installed/);
  });

  it.each([0, -5, 1.5, Number.NaN])('rejects a timeout of %p', (timeoutMs) => {
    const app: ShutdownTarget = { close: () => Promise.resolve() };

    expect(() =>
      installGracefulShutdown(app, {
        serviceName: 'svc',
        timeoutMs,
        signalSource: new FakeSignals(),
      }),
    ).toThrow(RangeError);
  });

  it('registers nothing on the source when validation fails', () => {
    const signals = new FakeSignals();
    const app: ShutdownTarget = { close: () => Promise.resolve() };

    expect(() =>
      installGracefulShutdown(app, { serviceName: 'svc', timeoutMs: 0, signalSource: signals }),
    ).toThrow(RangeError);
    expect(signals.listeners.size).toBe(0);
  });
});
