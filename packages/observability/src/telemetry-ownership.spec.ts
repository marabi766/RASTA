import { createServer as createHttpServer, get, type Server as HttpServer } from 'node:http';
import { Server as NetServer, createServer, type AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { metrics, trace } from '@opentelemetry/api';
import { NodeSDK, type metrics as sdkMetrics } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { telemetryRefusal, type TelemetryStage } from './diagnostics';
import {
  TELEMETRY_ALREADY_STARTING,
  TELEMETRY_STILL_STOPPING,
  TelemetryRefusedError,
  initTelemetry,
  shutdownTelemetry,
} from './telemetry';

/**
 * What a start owns (#426 r1 F3). A refused `initTelemetry` reports its
 * refusal with nothing of the start listening, scheduled or registered, so
 * the Prometheus port it was given can be bound again at once — the same port,
 * not another one — and a retry under a fixed configuration starts. Every
 * exporter it built or was handed is shut down without being flushed, and
 * what that shutdown throws or rejects with is dropped. Concurrent and
 * repeated calls cannot leave two SDKs or a listener behind.
 */

const USER = 'private-sentinel-79';
const PASSWORD = 'JZ97-another-secret';
const SENTINEL = /sentinel|jz97|another[-_]secret/i;
/** Both sentinels as credentials, and a port that is not one: every URL-taking exporter refuses it. */
const BAD_URL = `http://${USER}:${PASSWORD}@127.0.0.1:bad`;

/** Everything a thrown value can print: message, stack, own properties, inspection. */
function everythingOf(value: unknown): string {
  if (!(value instanceof Error)) return inspect(value, { depth: 10 });
  return [
    value.message,
    value.stack ?? '',
    JSON.stringify(value, Object.getOwnPropertyNames(value)),
    inspect(value, { depth: 10, showHidden: true }),
    value.cause === undefined ? '' : inspect(value.cause, { depth: 10, showHidden: true }),
  ].join('\n');
}

/** Exactly `env` as the OTEL_* environment until {@link restoreEnv}. */
let savedEnv: [string, string | undefined][] = [];
function setOtelEnv(env: Record<string, string | undefined>): void {
  savedEnv = Object.entries(process.env).filter(([key]) => key.startsWith('OTEL_'));
  for (const [key] of savedEnv) delete process.env[key];
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
}
function restoreEnv(): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('OTEL_')) delete process.env[key];
  for (const [key, value] of savedEnv) process.env[key] = value;
  savedEnv = [];
}

/** `body`'s writes to stdout and stderr, captured instead of written. */
function captured<T>(body: () => T): { result: T; output: string } {
  const written: string[] = [];
  const capture = (chunk: unknown): boolean => {
    written.push(String(chunk));
    return true;
  };
  const out = jest.spyOn(process.stdout, 'write').mockImplementation(capture);
  const err = jest.spyOn(process.stderr, 'write').mockImplementation(capture);
  try {
    return { result: body(), output: written.join('') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

/** `initTelemetry`'s refusal, or null when it started. */
function refusalOf(start: () => unknown): TelemetryRefusedError | null {
  try {
    start();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(TelemetryRefusedError);
    return error as TelemetryRefusedError;
  }
}

/** A port nothing listens on: bound on port 0, recorded, released. */
async function freePort(host?: string): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, host, ready));
  const { port } = server.address() as AddressInfo;
  await new Promise((closed) => server.close(closed));
  return port;
}

/**
 * Binds exactly `port` and releases it: `'bound'`, or the error code. Without a
 * host the bind runs inside `listen()`, synchronously — at the moment of the call.
 */
function bind(port: number, host?: string): Promise<string> {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? 'error'));
    server.listen(port, host, () => server.close(() => done('bound')));
  });
}

/** The process resources that are held, not one-shot requests (`FSReqCallback`, …). */
function held(): string[] {
  return process
    .getActiveResourcesInfo()
    .filter((kind) => !/Req(Callback|Wrap)$/.test(kind))
    .sort();
}

/** What `now` holds beyond `before`, kind by kind: a closing handle of the spec's own may go. */
function added(before: readonly string[], now: readonly string[]): string[] {
  const left = [...before];
  return now.filter((kind) => {
    const index = left.indexOf(kind);
    if (index < 0) return true;
    left.splice(index, 1);
    return false;
  });
}

const nextMacrotask = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/**
 * What `body` started and left running: every `listen()` it called, and every
 * timer it scheduled and did not clear (a fired one-shot timer counts as
 * cleared). Unref'd ones too, which `getActiveResourcesInfo` does not list —
 * the Prometheus server and the periodic export timer are both unref'd.
 */
function started<T>(body: () => T): { result: T; listens: number; timers: number } {
  const live = new Set<unknown>();
  let listens = 0;
  const listen = jest.spyOn(NetServer.prototype, 'listen').mockImplementation(function (
    this: NetServer,
    ...args: unknown[]
  ) {
    listens += 1;
    return (realListen as (...a: unknown[]) => NetServer).apply(this, args);
  });
  const timeout = jest.spyOn(global, 'setTimeout').mockImplementation(((
    callback: (...a: unknown[]) => void,
    ...rest: unknown[]
  ) => {
    const handle: unknown = realSetTimeout(
      (...a: unknown[]) => {
        live.delete(handle);
        callback(...a);
      },
      ...(rest as [number]),
    );
    live.add(handle);
    return handle;
  }) as typeof setTimeout);
  const interval = jest.spyOn(global, 'setInterval').mockImplementation(((...args: unknown[]) => {
    const handle: unknown = (realSetInterval as (...a: unknown[]) => unknown)(...args);
    live.add(handle);
    return handle;
  }) as typeof setInterval);
  const clears = [
    jest.spyOn(global, 'clearTimeout').mockImplementation((handle) => {
      live.delete(handle);
      realClearTimeout(handle);
    }),
    jest.spyOn(global, 'clearInterval').mockImplementation((handle) => {
      live.delete(handle);
      realClearInterval(handle);
    }),
  ];
  try {
    const result = body();
    return { result, listens, timers: live.size };
  } finally {
    for (const spy of [listen, timeout, interval, ...clears]) spy.mockRestore();
  }
}
const realListen = NetServer.prototype.listen;
const realSetTimeout = setTimeout;
const realSetInterval = setInterval;
const realClearTimeout = clearTimeout;
const realClearInterval = clearInterval;

/** Records what it exported: InMemorySpanExporter forgets everything on shutdown. */
class RecordingExporter extends InMemorySpanExporter {
  readonly names: string[] = [];

  override export(...args: Parameters<InMemorySpanExporter['export']>): void {
    this.names.push(...args[0].map((span) => span.name));
    super.export(...args);
  }
}

/** An OTLP/HTTP collector on 127.0.0.1 that counts what reaches it. */
async function collector(): Promise<{
  url: string;
  requests: () => number;
  close(): Promise<void>;
}> {
  let requests = 0;
  const server: HttpServer = createHttpServer((request, response) => {
    requests += 1;
    request.resume();
    request.on('end', () => response.end());
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: () => requests,
    close: () =>
      new Promise((closed) => {
        server.closeAllConnections();
        server.close(() => closed());
      }),
  };
}

function metricsStatus(port: number): Promise<number> {
  return new Promise((done, fail) => {
    get({ host: 'localhost', port, path: '/metrics' }, (response) => {
      response.resume();
      done(response.statusCode ?? 0);
    }).on('error', fail);
  });
}

const tracerProviderName = (): string =>
  (
    trace.getTracerProvider() as unknown as { getDelegate(): { constructor: { name: string } } }
  ).getDelegate().constructor.name;

afterEach(async () => {
  await shutdownTelemetry().catch(() => undefined);
  restoreEnv();
});

describe('a refused start listens on nothing: the same port binds at once', () => {
  it.each([
    ['no host: a listen binds at once', undefined],
    ['host localhost: a listen binds after a lookup', 'localhost'],
  ] as const)(
    'the reported case: prometheus,otlp with gRPC metrics at an invalid port, refused twice; %s',
    async (_name, host) => {
      const port = await freePort(host);
      const env = {
        OTEL_METRICS_EXPORTER: 'prometheus,otlp',
        OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: BAD_URL,
        OTEL_EXPORTER_PROMETHEUS_HOST: host,
        OTEL_EXPORTER_PROMETHEUS_PORT: String(port),
        OTEL_TRACES_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
      };
      setOtelEnv(env);
      await nextMacrotask();
      const before = held();
      const {
        result: { result: refusals, listens, timers },
        output,
      } = captured(() =>
        started(() => [
          refusalOf(() => initTelemetry({ serviceName: 'ownership-spec' })),
          refusalOf(() => initTelemetry({ serviceName: 'ownership-spec' })),
        ]),
      );
      // Sampled in the tick the refusal was thrown in: nothing to wait for.
      const atRefusal = held();
      const rebound = bind(port, host);
      expect({ listens, timers }).toEqual({ listens: 0, timers: 0 });
      for (const refusal of refusals) {
        expect(refusal?.message).toBe(telemetryRefusal('metrics', env));
        expect(everythingOf(refusal)).not.toMatch(SENTINEL);
      }
      expect(output).not.toMatch(SENTINEL);
      expect(added(before, atRefusal)).toEqual([]);
      await expect(rebound).resolves.toBe('bound');
      await nextMacrotask();
      expect(added(before, held())).toEqual([]);
      // Again once any lookup a listen would have waited for is long done.
      await new Promise((done) => setTimeout(done, 50));
      await expect(bind(port, host)).resolves.toBe('bound');

      // The retry, configuration fixed: it starts and listens on that same port …
      delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
      delete process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL;
      process.env.OTEL_METRICS_EXPORTER = 'prometheus';
      expect(refusalOf(() => initTelemetry({ serviceName: 'ownership-spec' }))).toBeNull();
      // (a listen with a host binds after its lookup: shutdown waits for it, a request may not)
      if (host === undefined) await expect(metricsStatus(port)).resolves.toBe(200);
      // … until it is shut down.
      await shutdownTelemetry();
      await expect(bind(port, host)).resolves.toBe('bound');
    },
  );

  interface Case {
    name: string;
    stage: TelemetryStage;
    /** `PORT` stands for the Prometheus port, `COLLECTOR` for the counting collector. */
    env: Record<string, string>;
    /** Hand `initTelemetry` its own exporters too. */
    explicit?: boolean;
  }

  /**
   * One refusal per stage, each after every exporter kind that stage or an
   * earlier one builds: the Prometheus listener, periodic readers, the
   * exporters the SDK's own builders make before the one that refuses.
   */
  const CASES: readonly Case[] = [
    {
      name: 'metrics: console and Prometheus readers, then gRPC metrics refuse an illegal header',
      stage: 'metrics',
      env: {
        OTEL_METRICS_EXPORTER: 'console,prometheus,otlp',
        OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_METRICS_HEADERS: `${USER}%C3%A9=${PASSWORD}`,
        OTEL_TRACES_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
      },
    },
    {
      name: 'traces: metrics registered, OTLP traces built, then Zipkin refuses',
      stage: 'traces',
      env: {
        OTEL_METRICS_EXPORTER: 'otlp,prometheus',
        OTEL_TRACES_EXPORTER: 'otlp,zipkin',
        OTEL_EXPORTER_ZIPKIN_ENDPOINT: BAD_URL,
        OTEL_LOGS_EXPORTER: 'none',
      },
    },
    {
      name: 'logs: metrics and traces registered, the console log exporter built, then gRPC logs refuse',
      stage: 'logs',
      env: {
        OTEL_METRICS_EXPORTER: 'console,prometheus,otlp',
        OTEL_TRACES_EXPORTER: 'console,otlp',
        OTEL_LOGS_EXPORTER: 'console,otlp',
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: BAD_URL,
      },
    },
    {
      name: 'logs, with the SDK self-metrics on',
      stage: 'logs',
      env: {
        OTEL_NODE_EXPERIMENTAL_SDK_METRICS: 'true',
        OTEL_METRICS_EXPORTER: 'prometheus,otlp',
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: BAD_URL,
      },
    },
    {
      name: 'logs: an explicit trace exporter, then gRPC logs refuse',
      stage: 'logs',
      explicit: true,
      env: {
        OTEL_METRICS_EXPORTER: 'prometheus',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: BAD_URL,
      },
    },
  ];

  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s: nothing held, sent or registered; the port binds; every exporter shut down',
    async (_name, testCase) => {
      const port = await freePort();
      const sink = await collector();
      try {
        const env: Record<string, string> = {
          OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
          OTEL_EXPORTER_PROMETHEUS_PORT: String(port),
          ...testCase.env,
        };
        setOtelEnv(env);
        const traceExporter = new InMemorySpanExporter();
        const shutdown = jest.spyOn(traceExporter, 'shutdown');
        await nextMacrotask();
        const before = held();
        const {
          result: { result: refusal, listens, timers },
          output,
        } = captured(() =>
          started(() =>
            refusalOf(() =>
              initTelemetry({
                serviceName: 'ownership-spec',
                traceExporter: testCase.explicit ? traceExporter : undefined,
              }),
            ),
          ),
        );
        const atRefusal = held();
        const rebound = bind(port);
        expect({ listens, timers }).toEqual({ listens: 0, timers: 0 });
        expect(refusal?.message).toBe(telemetryRefusal(testCase.stage, env));
        expect(added(before, atRefusal)).toEqual([]);
        await expect(rebound).resolves.toBe('bound');
        await nextMacrotask();
        expect(added(before, held())).toEqual([]);
        expect(sink.requests()).toBe(0);
        expect(output).not.toMatch(SENTINEL);
        expect(metrics.getMeterProvider().constructor.name).toBe('NoopMeterProvider');
        expect(tracerProviderName()).toBe('NoopTracerProvider');
        if (testCase.explicit) expect(shutdown).toHaveBeenCalledTimes(1);
      } finally {
        await sink.close();
      }
    },
  );

  it('under OTEL_SDK_DISABLED a valid Prometheus reader is built but never listens', async () => {
    const port = await freePort();
    setOtelEnv({
      OTEL_SDK_DISABLED: 'true',
      OTEL_METRICS_EXPORTER: 'prometheus',
      OTEL_EXPORTER_PROMETHEUS_PORT: String(port),
    });
    expect(initTelemetry({ serviceName: 'ownership-spec' })).toBeInstanceOf(NodeSDK);
    await expect(bind(port)).resolves.toBe('bound');
  });
});

describe('a release that fails reports nothing of itself', () => {
  /**
   * A rejected shutdown whose `then` is watched: the refusal must attach a
   * rejection handler (an unhandled one would reach Node's report, and the
   * report quotes the reason).
   */
  function rejecting(): { shutdown: () => Promise<void>; handled: () => boolean } {
    const rejection = Promise.reject(new Error(`could not flush to ${BAD_URL}`));
    // Handled here too, so that a broken release fails the assertion below, not the run.
    rejection.catch(() => undefined);
    const then = jest.spyOn(rejection, 'then');
    return {
      shutdown: () => rejection,
      handled: () => then.mock.calls.some(([, onRejected]) => typeof onRejected === 'function'),
    };
  }

  it.each([
    ['rejects', rejecting],
    [
      'throws',
      () => ({
        shutdown: (): Promise<void> => {
          throw new Error(`could not flush to ${BAD_URL}`);
        },
        handled: () => true,
      }),
    ],
  ] as const)(
    'an owned exporter whose shutdown %s, quoting both sentinels: the fixed refusal, the failure dropped',
    async (_how, failing) => {
      const env = {
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_TRACES_EXPORTER: 'zipkin',
        OTEL_EXPORTER_ZIPKIN_ENDPOINT: BAD_URL,
        OTEL_LOG_LEVEL: 'ALL',
      };
      setOtelEnv(env);
      const { shutdown, handled } = failing();
      const release = jest.fn(shutdown);
      const logRecordExporter = {
        export: (_records: unknown, done: (result: { code: number }) => void) => done({ code: 0 }),
        shutdown: release,
      };
      const { result: refusal, output } = captured(() =>
        refusalOf(() =>
          initTelemetry({
            serviceName: 'ownership-spec',
            logRecordExporter: logRecordExporter as never,
          }),
        ),
      );
      // Called before the refusal was thrown, and its failure handled by then.
      expect(release).toHaveBeenCalledTimes(1);
      expect(handled()).toBe(true);
      await nextMacrotask();
      expect(refusal?.message).toBe(telemetryRefusal('traces', env));
      expect(refusal?.cause).toBeUndefined();
      expect(everythingOf(refusal)).not.toMatch(SENTINEL);
      expect(output).not.toMatch(SENTINEL);
    },
  );
});

describe('concurrent and repeated calls', () => {
  const quiet = { OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none' };

  it('a call made while initTelemetry is building is refused; the outer one starts the only SDK', () => {
    setOtelEnv(quiet);
    let inner: unknown;
    const config = {
      serviceName: 'ownership-spec',
      traceExporter: new InMemorySpanExporter(),
      // Read inside the build: a re-entrant call from there.
      get sampleRatio(): number {
        try {
          initTelemetry({ serviceName: 'ownership-spec-inner' });
        } catch (error) {
          inner = error;
        }
        return 1;
      },
    };
    const outer = initTelemetry(config);
    expect(inner).toBeInstanceOf(TelemetryRefusedError);
    expect((inner as Error).message).toBe(TELEMETRY_ALREADY_STARTING);
    expect(outer).toBeInstanceOf(NodeSDK);
    expect(tracerProviderName()).toBe('TracerProvider');
    // Nothing stays latched: a later call returns the one SDK.
    expect(initTelemetry({ serviceName: 'ownership-spec' })).toBe(outer);
  });

  it('a call made while a shutdown is pending is refused; after it, a new SDK starts and is used', async () => {
    setOtelEnv(quiet);
    const first = new RecordingExporter();
    const sdk = initTelemetry({ serviceName: 'ownership-spec', traceExporter: first });
    expect(initTelemetry({ serviceName: 'ownership-spec' })).toBe(sdk);
    const stopping = shutdownTelemetry();
    expect(refusalOf(() => initTelemetry({ serviceName: 'ownership-spec' }))?.message).toBe(
      TELEMETRY_STILL_STOPPING,
    );
    await stopping;
    const second = new RecordingExporter();
    const next = initTelemetry({ serviceName: 'ownership-spec', traceExporter: second });
    expect(next).not.toBe(sdk);
    trace.getTracer('ownership-spec').startSpan('after-restart').end();
    await shutdownTelemetry();
    expect(second.names).toEqual(['after-restart']);
    expect(first.names).toEqual([]);
  });

  it('two shutdowns at once share one outcome: neither resolves before the listener closed', async () => {
    const port = await freePort('localhost');
    setOtelEnv({
      ...quiet,
      OTEL_TRACES_EXPORTER: 'none',
      OTEL_METRICS_EXPORTER: 'prometheus',
      OTEL_EXPORTER_PROMETHEUS_HOST: 'localhost',
      OTEL_EXPORTER_PROMETHEUS_PORT: String(port),
    });
    initTelemetry({ serviceName: 'ownership-spec' });
    const first = shutdownTelemetry();
    const second = shutdownTelemetry();
    expect(second).toBe(first);
    await second;
    await nextMacrotask();
    await new Promise((done) => setTimeout(done, 50));
    await expect(bind(port, 'localhost')).resolves.toBe('bound');
  });
});

describe('the metric readers are the ones the NodeSDK constructor builds', () => {
  type Reader = sdkMetrics.MetricReader & Record<string, unknown>;

  /** What identifies a reader: its class, its exporter's class and its settings. */
  function describeReader(reader: Reader): unknown {
    const exporter = reader._exporter as object | undefined;
    return {
      reader: Object.getPrototypeOf(reader) as unknown,
      exporter: exporter && (Object.getPrototypeOf(exporter) as unknown),
      interval: reader._exportInterval,
      timeout: reader._exportTimeout,
      prometheus: [reader._host, reader._port, reader._endpoint, reader._prefix],
    };
  }

  const readersOf = (sdk: NodeSDK): Reader[] =>
    (sdk as unknown as { _meterProviderConfig: { readers: Reader[] } })._meterProviderConfig
      .readers;

  const SELECTIONS: readonly Record<string, string>[] = [
    {},
    { OTEL_METRICS_EXPORTER: 'otlp' },
    { OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
    { OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json' },
    { OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/protobuf' },
    { OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'unknown' },
    { OTEL_METRICS_EXPORTER: 'console' },
    { OTEL_METRICS_EXPORTER: 'prometheus' },
    { OTEL_METRICS_EXPORTER: 'prometheus,otlp,console' },
    { OTEL_METRICS_EXPORTER: 'console , otlp,otlp' },
    { OTEL_METRICS_EXPORTER: 'otlp,none' },
    { OTEL_METRICS_EXPORTER: 'none' },
    { OTEL_METRICS_EXPORTER: 'bogus,prometheus' },
    { OTEL_METRICS_EXPORTER: 'otlp', OTEL_METRIC_EXPORT_INTERVAL: '1000' },
    {
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_METRIC_EXPORT_INTERVAL: '5000',
      OTEL_METRIC_EXPORT_TIMEOUT: '9000',
    },
  ];

  it.each(SELECTIONS.map((env) => [JSON.stringify(env), env] as const))(
    '%s',
    async (_name, selection) => {
      const port = await freePort();
      setOtelEnv({
        ...selection,
        OTEL_TRACES_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_EXPORTER_PROMETHEUS_PORT: String(port),
      });
      // The SDK's own: its Prometheus exporter listens at once, so it is closed first.
      const { result: theirs } = captured(() => readersOf(new NodeSDK({})));
      const expected = theirs.map(describeReader);
      await Promise.all(
        theirs.filter((reader) => reader._server !== undefined).map((reader) => reader.shutdown()),
      );
      const { result: ours } = captured(() => initTelemetry({ serviceName: 'ownership-spec' }));
      expect(readersOf(ours as NodeSDK).map(describeReader)).toEqual(expected);
    },
  );
});
