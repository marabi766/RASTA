import { ApplicationFailure } from '@temporalio/activity';
import { MockActivityEnvironment } from '@temporalio/testing';
import { Runtime } from '@temporalio/worker';
// The SDK's option compiler, what `Runtime.install` runs (no exports map: a
// deep import is how it is reached).
import { compileOptions } from '@temporalio/worker/lib/runtime-options';
import { createLogger, type Logger } from '@rasta/logging';
import {
  TemporalRuntimeLogger,
  installTemporalRuntimeLogger,
  temporalRuntimeOptions,
} from './runtime-logger';

/**
 * The Temporal SDK logs an activity that throws ("Activity failed") with the
 * error, from its own activity executor — not through Nest. Without a runtime
 * logger that record goes to stderr raw (Codex on #296, F1). These run the real
 * `Activity` class of the SDK (the one a worker uses) with the adapter, over a
 * stub of the pino logger so what is asserted is exactly what would be written.
 */

const PASSWORD = 'LEAKPASSWORD';
const TOKEN = 'LEAKTOKEN0123456789';
const DSN = `postgresql://app:${PASSWORD}@db.internal:5432/app`;

interface Call {
  level: string;
  fields: Record<string, unknown>;
  msg: string;
}

function stubLogger(): { logger: Logger; calls: Call[] } {
  const calls: Call[] = [];
  const entry = (level: string) => (fields: Record<string, unknown>, msg: string) => {
    calls.push({ level, fields, msg });
  };
  const logger = {
    trace: entry('trace'),
    debug: entry('debug'),
    info: entry('info'),
    warn: entry('warn'),
    error: entry('error'),
  } as unknown as Logger;
  return { logger, calls };
}

/** Everything a call would write, Error message, stack and cause chain included. */
function textOf(calls: Call[]): string {
  const parts: string[] = [JSON.stringify(calls)];
  for (const { fields } of calls) {
    for (
      let err = fields.err as Error | undefined;
      err instanceof Error;
      err = err.cause as Error
    ) {
      parts.push(err.message, err.stack ?? '');
    }
  }
  return parts.join('\n');
}

describe('TemporalRuntimeLogger through the SDK activity executor', () => {
  async function failActivity(error: Error): Promise<Call[]> {
    const { logger, calls } = stubLogger();
    const env = new MockActivityEnvironment({}, { logger: new TemporalRuntimeLogger(logger) });
    // `run()` skips the executor's own logging; `execute()` is the path a
    // worker takes, and the one that logs "Activity failed" with the error.
    const { activity } = env as unknown as {
      activity: {
        execute(
          fn: () => Promise<never>,
          input: { args: unknown[]; headers: object },
        ): Promise<unknown>;
      };
    };
    await expect(
      activity.execute(
        async () => {
          throw error;
        },
        { args: [], headers: {} },
      ),
    ).rejects.toBeDefined();
    return calls;
  }

  it('logs "Activity failed" scrubbed: message, stack and cause', async () => {
    const failure = ApplicationFailure.nonRetryable(
      `economic-service refused: ${DSN} Authorization: Bearer ${TOKEN}`,
      'EconomicRefused',
    );
    (failure as { cause?: unknown }).cause = new Error(`inner ${DSN}`);

    const calls = await failActivity(failure);

    const failed = calls.filter((call) => call.msg === 'Activity failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ level: 'warn', fields: { component: 'temporal' } });
    // pino serializes an Error under `err` (message, stack, cause chain).
    const err = failed[0].fields.err as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('economic-service refused');
    expect(String(err.cause)).toContain('inner');
    const text = textOf(calls);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(TOKEN);
  });

  it('caps a 200 kB error body', async () => {
    const calls = await failActivity(
      ApplicationFailure.nonRetryable(`${'x'.repeat(200_000)} ${DSN}`, 'Big'),
    );

    const text = textOf(calls);
    expect(calls.some((call) => call.msg === 'Activity failed')).toBe(true);
    expect(text).not.toContain(PASSWORD);
    expect(text.length).toBeLessThan(60_000);
  });

  it('scrubs a plain Error as well', async () => {
    const calls = await failActivity(new Error(`connect ECONNREFUSED ${DSN}`));

    expect(calls.some((call) => call.msg === 'Activity failed')).toBe(true);
    expect(textOf(calls)).not.toContain(PASSWORD);
  });
});

describe('TemporalRuntimeLogger', () => {
  it('never throws on a hostile metadata value, and still writes a line', () => {
    const { logger, calls } = stubLogger();
    const adapter = new TemporalRuntimeLogger(logger);
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('trap');
        },
      },
    );

    expect(() => adapter.error('failed', { error: hostile })).not.toThrow();
    expect(() =>
      adapter.warn('failed', {
        get error(): never {
          throw new Error('getter');
        },
      }),
    ).not.toThrow();

    expect(calls.map((call) => call.msg)).toEqual(['failed', 'failed']);
  });

  it('maps the five levels', () => {
    const { logger, calls } = stubLogger();
    const adapter = new TemporalRuntimeLogger(logger);

    adapter.trace('a');
    adapter.debug('b');
    adapter.info('c');
    adapter.warn('d');
    adapter.error('e');

    expect(calls.map((call) => call.level)).toEqual(['trace', 'debug', 'info', 'warn', 'error']);
  });
});

/**
 * Core — the native layer under `NativeConnection` and `Worker` — logs apart
 * from the runtime's `logger`, through an exporter chosen by the SDK's option
 * compiler; without `logging.forward` that exporter is Core's console one,
 * writing to stderr raw (Codex on #296, r2 F1). These run that compiler — the
 * one `Runtime.install` runs — and its native log collector, network-free.
 */
describe('Core (native) logs', () => {
  type Compiled = ReturnType<typeof compileOptions>;
  const exporterOf = (compiled: Compiled) =>
    compiled.runtimeOptions.logExporter as { type: string; receiver?: (entries: string[]) => void };
  const close = (compiled: Compiled) => (compiled.logger as { close?: () => void }).close?.();

  it('are forwarded: the compiler selects the forwarding exporter, not the console one', () => {
    const forwarded = compileOptions(temporalRuntimeOptions(stubLogger().logger));
    // The configuration before this fix, as a control.
    const logOnly = compileOptions({ logger: new TemporalRuntimeLogger(stubLogger().logger) });
    try {
      expect(exporterOf(forwarded).type).toBe('forward');
      expect(exporterOf(logOnly).type).toBe('console');
    } finally {
      close(forwarded);
      close(logOnly);
    }
  });

  it('reach the destination scrubbed: a Core poll warning carrying credentials', () => {
    const lines: string[] = [];
    const base = createLogger({
      serviceName: 'marketplace-service',
      level: 'trace',
      environment: 'test',
      pretty: false,
      destination: { write: (line: string) => void lines.push(line) },
    });
    const compiled = compileOptions(temporalRuntimeOptions(base));

    // An entry as Core pushes it: JSON, nanosecond timestamp, tracing fields.
    exporterOf(compiled).receiver!([
      JSON.stringify({
        timestamp: String(BigInt(Date.now()) * 1_000_000n),
        level: 'WARN',
        message: `Error when polling: status: Unauthenticated, message: "Authorization: Bearer ${TOKEN}"`,
        target: 'temporalio_sdk_core::pollers::poll_buffer',
        spanContexts: [],
        fields: { error: `connect ${DSN}` },
      }),
    ]);
    close(compiled); // flushes what the collector buffers

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'warn',
      component: 'temporal',
      sdkComponent: 'core',
      msg: expect.stringContaining('Error when polling') as unknown,
    });
    expect(lines[0]).not.toContain(TOKEN);
    expect(lines[0]).not.toContain(PASSWORD);
  });
});

describe('installTemporalRuntimeLogger', () => {
  it('installs the runtime with the adapter and Core forwarding, once', () => {
    const install = jest.spyOn(Runtime, 'install').mockImplementation(() => undefined as never);
    const env = { NODE_ENV: 'test', LOG_LEVEL: 'info', SERVICE_VERSION: '1' } as never;

    installTemporalRuntimeLogger(env);
    installTemporalRuntimeLogger(env);

    expect(install).toHaveBeenCalledTimes(1);
    const options = install.mock.calls[0][0];
    expect(options.logger).toBeInstanceOf(TemporalRuntimeLogger);
    const compiled = compileOptions(options);
    try {
      expect((compiled.runtimeOptions.logExporter as { type: string }).type).toBe('forward');
    } finally {
      (compiled.logger as { close?: () => void }).close?.();
    }
    install.mockRestore();
  });
});
