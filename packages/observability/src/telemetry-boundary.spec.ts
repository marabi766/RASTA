import { execFile } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttp2Server, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { inspect } from 'node:util';
import { metrics, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { telemetryRefusal, type TelemetryStage } from './diagnostics';
import {
  TELEMETRY_SHUTDOWN_FAILED,
  TelemetryRefusedError,
  initTelemetry,
  shutdownTelemetry,
} from './telemetry';

/**
 * Nothing the OpenTelemetry SDK throws while it is built or started reaches
 * the caller (#385 r6, Codex PR-385 r5 F1). Exporter constructors refuse a URL
 * with the whole URL on `.input` (OTLP over gRPC, Zipkin), and gRPC metadata
 * refuses a header key or value quoting it — outside `diag`, so the safe
 * logger never sees them. `initTelemetry` discards whatever any part of the SDK
 * throws and refuses with a fresh fixed error naming registered settings.
 *
 * Every case reaches its branch: gRPC selected per signal (and for all through
 * the general protocol), Zipkin selected, an invalid-port URL with both
 * sentinels as credentials, and a percent-encoded illegal header value and key
 * in the general and in each signal's own `*_HEADERS`. The control for each is
 * a bare NodeSDK under the same environment, which does throw a sentinel.
 */

/** The two sentinels of `scripts/refusal-probes.mjs`: a username and a password. */
const USER = 'private-sentinel-79';
const PASSWORD = 'JZ97-another-secret';
/** Any piece of either, in any spelling. */
const SENTINEL = /sentinel|jz97|another[-_]secret/i;
/** Both as credentials, and a port that is not one. */
const CREDENTIAL_URL = `http://${USER}:${PASSWORD}@127.0.0.1:bad`;
/** A gRPC header whose value is illegal once percent-decoded (`é`). */
const ILLEGAL_VALUE = `${USER}=${PASSWORD}%C3%A9`;
/** A gRPC header whose key is illegal once percent-decoded. */
const ILLEGAL_KEY = `${USER}%C3%A9=${PASSWORD}`;

const SIGNALS = ['TRACES', 'METRICS', 'LOGS'] as const;
type Signal = (typeof SIGNALS)[number];
const STAGE_OF: Record<Signal, TelemetryStage> = {
  TRACES: 'traces',
  METRICS: 'metrics',
  LOGS: 'logs',
};

/** Only `signal` exported, over gRPC (its own protocol setting), the others off. */
function grpcOnly(signal: Signal): Record<string, string> {
  const env: Record<string, string> = {};
  for (const other of SIGNALS) env[`OTEL_${other}_EXPORTER`] = other === signal ? 'otlp' : 'none';
  env[`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`] = 'grpc';
  return env;
}

interface Branch {
  name: string;
  stage: TelemetryStage;
  env: Record<string, string>;
}

const BRANCHES: readonly Branch[] = Object.freeze([
  ...SIGNALS.map((signal) => ({
    name: `${signal} over gRPC, its own endpoint invalid with credentials`,
    stage: STAGE_OF[signal],
    env: { ...grpcOnly(signal), [`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`]: CREDENTIAL_URL },
  })),
  {
    // The constructor builds the metric reader first.
    name: 'every signal over gRPC (general protocol), the general endpoint invalid',
    stage: 'metrics',
    env: {
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
      OTEL_EXPORTER_OTLP_ENDPOINT: CREDENTIAL_URL,
    },
  },
  {
    name: 'Zipkin, its endpoint invalid with credentials',
    stage: 'traces',
    env: {
      OTEL_TRACES_EXPORTER: 'zipkin',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_LOGS_EXPORTER: 'none',
      OTEL_EXPORTER_ZIPKIN_ENDPOINT: CREDENTIAL_URL,
    },
  },
  ...SIGNALS.flatMap((signal) =>
    (['', `${signal}_`] as const).flatMap((scope) =>
      (
        [
          ['value', ILLEGAL_VALUE],
          ['key', ILLEGAL_KEY],
        ] as const
      ).map(([part, header]) => ({
        name: `${signal} over gRPC, an illegal header ${part} in OTEL_EXPORTER_OTLP_${scope}HEADERS`,
        stage: STAGE_OF[signal],
        env: { ...grpcOnly(signal), [`OTEL_EXPORTER_OTLP_${scope}HEADERS`]: header },
      })),
    ),
  ),
]);

const LOG_LEVELS = [
  undefined,
  'NONE',
  'ERROR',
  'WARN',
  'INFO',
  'DEBUG',
  'VERBOSE',
  'ALL',
  'warn',
  PASSWORD,
] as const;

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

/** Runs `body` with exactly `env` as the OTEL_* environment, restoring it after. */
function withOtelEnv<T>(env: Record<string, string | undefined>, body: () => T): T {
  const saved = Object.entries(process.env).filter(([key]) => key.startsWith('OTEL_'));
  for (const [key] of saved) delete process.env[key];
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  try {
    return body();
  } finally {
    for (const key of Object.keys(process.env))
      if (key.startsWith('OTEL_')) delete process.env[key];
    for (const [key, value] of saved) process.env[key] = value;
  }
}

/** `body`'s writes to stdout and stderr, captured instead of written. */
function captured(body: () => void): string {
  const written: string[] = [];
  const capture = (chunk: unknown): boolean => {
    written.push(String(chunk));
    return true;
  };
  const out = jest.spyOn(process.stdout, 'write').mockImplementation(capture);
  const err = jest.spyOn(process.stderr, 'write').mockImplementation(capture);
  try {
    body();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return written.join('');
}

describe('initTelemetry: the SDK construction and start boundary (in process)', () => {
  afterEach(async () => {
    await shutdownTelemetry().catch(() => undefined);
  });

  describe.each(BRANCHES.map((branch) => [branch.name, branch] as const))('%s', (_, branch) => {
    it('the control: a bare NodeSDK under this environment throws a sentinel', () => {
      let thrown: unknown;
      withOtelEnv(branch.env, () => {
        try {
          new NodeSDK({}).start();
        } catch (error) {
          thrown = error;
        }
      });
      expect(thrown).toBeDefined();
      expect(everythingOf(thrown)).toMatch(SENTINEL);
      trace.disable();
      metrics.disable();
    });

    it.each(LOG_LEVELS.map((level) => [level === PASSWORD ? '<sentinel>' : String(level), level]))(
      'OTEL_LOG_LEVEL=%s: refused with a fresh fixed error, nothing of either sentinel anywhere',
      (_level, level) => {
        const env = { ...branch.env, OTEL_LOG_LEVEL: level };
        let thrown: unknown;
        const output = captured(() =>
          withOtelEnv(env, () => {
            try {
              initTelemetry({ serviceName: 'boundary-spec' });
            } catch (error) {
              thrown = error;
            }
          }),
        );
        expect(thrown).toBeInstanceOf(TelemetryRefusedError);
        const error = thrown as TelemetryRefusedError;
        expect(error.message).toBe(telemetryRefusal(branch.stage, env));
        expect(error.cause).toBeUndefined();
        expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'name', 'stack']);
        expect(everythingOf(error)).not.toMatch(SENTINEL);
        expect(output).not.toMatch(SENTINEL);
        // Nothing of a refused start stays registered.
        expect(metrics.getMeterProvider().constructor.name).toBe('NoopMeterProvider');
      },
    );

    it('with OTEL_SDK_DISABLED=true: the metric reader the constructor builds is refused alike; nothing else starts', () => {
      const env = { ...branch.env, OTEL_SDK_DISABLED: 'true', OTEL_LOG_LEVEL: 'ALL' };
      let thrown: unknown;
      const output = captured(() =>
        withOtelEnv(env, () => {
          try {
            initTelemetry({ serviceName: 'boundary-spec' });
          } catch (error) {
            thrown = error;
          }
        }),
      );
      if (branch.stage === 'metrics') {
        expect(thrown).toBeInstanceOf(TelemetryRefusedError);
        expect((thrown as Error).message).toBe(telemetryRefusal('metrics', env));
      } else {
        expect(thrown).toBeUndefined();
      }
      expect(everythingOf(thrown)).not.toMatch(SENTINEL);
      expect(output).not.toMatch(SENTINEL);
    });
  });

  it('a refusal after start registered providers unregisters them all', () => {
    // Metrics and traces to the console (valid, no network) are registered by
    // `start()` before it builds the log exporter, which then refuses.
    const env = {
      OTEL_TRACES_EXPORTER: 'console',
      OTEL_METRICS_EXPORTER: 'console',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'grpc',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: CREDENTIAL_URL,
    };
    let thrown: unknown;
    captured(() =>
      withOtelEnv(env, () => {
        try {
          initTelemetry({ serviceName: 'boundary-spec' });
        } catch (error) {
          thrown = error;
        }
      }),
    );
    expect((thrown as Error).message).toBe(telemetryRefusal('logs', env));
    expect(metrics.getMeterProvider().constructor.name).toBe('NoopMeterProvider');
    const delegate = (
      trace.getTracerProvider() as unknown as { getDelegate(): { constructor: { name: string } } }
    ).getDelegate();
    expect(delegate.constructor.name).toBe('NoopTracerProvider');
  });

  it('a shutdown the SDK fails rejects with the fixed error, nothing of the SDK’s', async () => {
    // The exporter's own shutdown refuses quoting both sentinels: NodeSDK
    // passes that rejection up; shutdownTelemetry may not.
    const exporter = {
      export: (_spans: unknown, done: (result: { code: number }) => void) => done({ code: 0 }),
      shutdown: () => Promise.reject(new Error(`could not flush to ${CREDENTIAL_URL}`)),
      forceFlush: () => Promise.resolve(),
    };
    withOtelEnv({ OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none' }, () =>
      initTelemetry({ serviceName: 'boundary-spec', traceExporter: exporter }),
    );
    const rejected: unknown = await shutdownTelemetry().catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(TelemetryRefusedError);
    expect((rejected as Error).message).toBe(TELEMETRY_SHUTDOWN_FAILED);
    expect(everythingOf(rejected)).not.toMatch(SENTINEL);
    // And the SDK is gone: a second shutdown has nothing to do.
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('a refusal names registered settings only — never a name the environment made up', () => {
    const made = `OTEL_EXPORTER_OTLP_${PASSWORD.toUpperCase().replaceAll('-', '_')}`;
    const text = telemetryRefusal('traces', { [made]: 'x', OTEL_TRACES_EXPORTER: 'zipkin' });
    expect(text).toBe(
      'OpenTelemetry refused its trace exporter configuration (OTEL_TRACES_EXPORTER); ' +
        "the SDK's own error is withheld, it may repeat configured values",
    );
  });
});

// ---------------------------------------------------------------------------
// Child processes: what Node prints for a refusal nobody catches, what a
// refusal leaves behind, async reporting, and the positive controls.
// ---------------------------------------------------------------------------

const FIXTURE = resolve(__dirname, '__tests__/telemetry-boundary.fixture.ts');
const SWC_OPTIONS = resolve(__dirname, '../../../jest.swc.cjs');
const CHILD_TIMEOUT_MS = 90_000;
const CONCURRENCY = 4;

const RUN_FIXTURE = `
const { readFileSync } = require('node:fs');
const swc = require('@swc/core');
const options = require(${JSON.stringify(SWC_OPTIONS)});
require.extensions['.ts'] = (module, filename) => {
  const { code } = swc.transformSync(readFileSync(filename, 'utf8'), { ...options, filename, swcrc: false });
  module._compile(code, filename);
};
require(${JSON.stringify(FIXTURE)});
`;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  outcome: Record<string, unknown>;
}

function childEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('OTEL_')),
  );
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  return env;
}

function runFixture(mode: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<Run> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      ['-e', RUN_FIXTURE, mode, ...args],
      { env, timeout: CHILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const last = stdout.trim().split('\n').pop() ?? '';
        let outcome: Record<string, unknown> = {};
        try {
          outcome = JSON.parse(last) as Record<string, unknown>;
        } catch {
          outcome = {};
        }
        const code = error ? ((error as { code?: number }).code ?? null) : 0;
        done({ code: typeof code === 'number' ? code : null, stdout, stderr, outcome });
      },
    );
  });
}

async function inPool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  return results;
}

/** What a collector was sent: `<method> <path> <content-type>`, per request. */
interface Collector {
  url: string;
  received: string[];
  close: () => Promise<void>;
}

/**
 * An OTLP/HTTP and Zipkin collector on 127.0.0.1. `failing`: every request is
 * answered 500 with a body quoting both sentinels — a collector's answer the
 * exporters report through `diag`.
 */
async function httpCollector(failing: boolean): Promise<Collector> {
  const received: string[] = [];
  const server: Server = createHttpServer((request, response) => {
    request.resume();
    request.on('end', () => {
      received.push(`${request.method} ${request.url} ${request.headers['content-type']}`);
      if (failing) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(`refused ${USER} ${PASSWORD}`);
      } else {
        response.writeHead(request.url === '/api/v2/spans' ? 202 : 200, {
          'content-type': String(request.headers['content-type'] ?? 'application/json'),
        });
        response.end(request.headers['content-type'] === 'application/json' ? '{}' : '');
      }
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((closed) => server.close(() => closed())),
  };
}

/**
 * An OTLP/gRPC collector on 127.0.0.1 (cleartext HTTP/2): every unary call is
 * answered with an empty message — a valid empty Export response — or, when
 * `failing`, grpc-status 13 with a message quoting both sentinels.
 */
async function grpcCollector(failing: boolean): Promise<Collector> {
  const received: string[] = [];
  const server: Http2Server = createHttp2Server();
  server.on('stream', (stream, headers) => {
    stream.resume();
    stream.on('end', () => {
      received.push(`POST ${headers[':path']} ${headers['content-type']}`);
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc' },
        { waitForTrailers: true },
      );
      stream.on('wantTrailers', () =>
        stream.sendTrailers(
          failing
            ? { 'grpc-status': '13', 'grpc-message': encodeURIComponent(`${USER} ${PASSWORD}`) }
            : { 'grpc-status': '0' },
        ),
      );
      stream.end(failing ? undefined : Buffer.from([0, 0, 0, 0, 0]));
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((closed) => server.close(() => closed())),
  };
}

const withCredentials = (url: string): string =>
  url.replace('http://', `http://${encodeURIComponent(USER)}:${encodeURIComponent(PASSWORD)}@`);

/** Legal header values that carry both sentinels, so a failure quoting the request would. */
const SENTINEL_HEADERS = `x-user=${USER},authorization=${PASSWORD}`;

const EXPECTED_PATHS = {
  http: ['/v1/traces', '/v1/metrics', '/v1/logs'],
  grpc: [
    '/opentelemetry.proto.collector.trace.v1.TraceService/Export',
    '/opentelemetry.proto.collector.metrics.v1.MetricsService/Export',
    '/opentelemetry.proto.collector.logs.v1.LogsService/Export',
  ],
};

const branch = (name: string): Record<string, string> => {
  const found = BRANCHES.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no branch ${name}`);
  return found.env;
};

/** One case per kind of branch, uncaught, at OTEL_LOG_LEVEL=ALL. */
const UNCAUGHT: readonly (readonly [string, Record<string, string>])[] = [
  ['traces endpoint', branch('TRACES over gRPC, its own endpoint invalid with credentials')],
  [
    'metrics endpoint, SDK disabled',
    {
      ...branch('METRICS over gRPC, its own endpoint invalid with credentials'),
      OTEL_SDK_DISABLED: 'true',
    },
  ],
  ['logs endpoint', branch('LOGS over gRPC, its own endpoint invalid with credentials')],
  ['zipkin endpoint', branch('Zipkin, its endpoint invalid with credentials')],
  [
    'metrics general header key',
    branch('METRICS over gRPC, an illegal header key in OTEL_EXPORTER_OTLP_HEADERS'),
  ],
  [
    'logs own header value',
    branch('LOGS over gRPC, an illegal header value in OTEL_EXPORTER_OTLP_LOGS_HEADERS'),
  ],
];

describe('initTelemetry in a child process', () => {
  const uncaught = new Map<string, Run>();
  let twice: Run;
  const exportRuns = new Map<string, Run>();
  const collectors: Record<string, Collector> = {};

  beforeAll(async () => {
    collectors.http = await httpCollector(false);
    collectors.grpc = await grpcCollector(false);
    collectors.failingHttp = await httpCollector(true);
    collectors.failingGrpc = await grpcCollector(true);
    const allOtlp = {
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
    };
    const exportCases: Record<string, Record<string, string>> = {
      'OTLP http/json': {
        ...allOtlp,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: collectors.http.url,
      },
      'OTLP http/protobuf': {
        ...allOtlp,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_EXPORTER_OTLP_ENDPOINT: collectors.http.url,
      },
      'OTLP grpc': {
        ...allOtlp,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_ENDPOINT: collectors.grpc.url,
      },
      'Zipkin traces': {
        OTEL_TRACES_EXPORTER: 'zipkin',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_EXPORTER_ZIPKIN_ENDPOINT: `${collectors.http.url}/api/v2/spans`,
      },
      console: {
        OTEL_TRACES_EXPORTER: 'console',
        OTEL_METRICS_EXPORTER: 'console',
        OTEL_LOGS_EXPORTER: 'console',
      },
      // Async reporting: the collector refuses every export quoting both
      // sentinels, the endpoint carries them as credentials and the headers as
      // values. All of it is reported, if at all, through the safe logger.
      'failing OTLP http/json': {
        ...allOtlp,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: withCredentials(collectors.failingHttp.url),
        OTEL_EXPORTER_OTLP_HEADERS: SENTINEL_HEADERS,
        OTEL_LOG_LEVEL: 'ALL',
      },
      'failing OTLP http/protobuf': {
        ...allOtlp,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_EXPORTER_OTLP_ENDPOINT: withCredentials(collectors.failingHttp.url),
        OTEL_EXPORTER_OTLP_HEADERS: SENTINEL_HEADERS,
        OTEL_LOG_LEVEL: 'ALL',
      },
      'failing OTLP grpc': {
        ...allOtlp,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_ENDPOINT: withCredentials(collectors.failingGrpc.url),
        OTEL_EXPORTER_OTLP_HEADERS: SENTINEL_HEADERS,
        OTEL_LOG_LEVEL: 'ALL',
      },
      'failing Zipkin': {
        OTEL_TRACES_EXPORTER: 'zipkin',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_EXPORTER_ZIPKIN_ENDPOINT: `${withCredentials(collectors.failingHttp.url)}/api/v2/spans`,
        OTEL_LOG_LEVEL: 'ALL',
      },
    };

    const tasks: (() => Promise<void>)[] = [];
    for (const [label, env] of UNCAUGHT) {
      tasks.push(async () => {
        uncaught.set(
          label,
          await runFixture('uncaught', childEnv({ ...env, OTEL_LOG_LEVEL: 'ALL' })),
        );
      });
    }
    tasks.push(async () => {
      twice = await runFixture(
        'twice',
        childEnv({ ...UNCAUGHT[0][1], OTEL_LOG_LEVEL: 'ALL' }),
        'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',
      );
    });
    for (const [name, env] of Object.entries(exportCases)) {
      tasks.push(async () => {
        exportRuns.set(name, await runFixture('exports', childEnv(env)));
      });
    }
    await inPool(tasks, CONCURRENCY);
  }, 600_000);

  afterAll(async () => {
    await Promise.all(Object.values(collectors).map((collector) => collector.close()));
  });

  it('an uncaught refusal, as a service prints it: the fixed error, no piece of a sentinel', () => {
    expect(uncaught.size).toBe(UNCAUGHT.length);
    for (const [name, run] of uncaught) {
      expect({ name, code: run.code }).toEqual({ name, code: 1 });
      expect(run.stderr).toMatch(/TelemetryRefusedError: OpenTelemetry refused its /);
      expect(run.stdout).not.toMatch(SENTINEL);
      expect(run.stderr).not.toMatch(SENTINEL);
    }
  });

  it('a refusal leaves no instrumentation or provider behind; a second call refuses again; a fixed one starts', () => {
    expect(twice.code).toBe(0);
    const outcome = twice.outcome as {
      first: { name: string; all: string } | null;
      second: { name: string; all: string } | null;
      third: unknown;
      afterFirst: Record<string, unknown>;
      afterThird: Record<string, unknown>;
      exported: number;
    };
    expect(outcome.first?.name).toBe('TelemetryRefusedError');
    expect(outcome.second?.name).toBe('TelemetryRefusedError');
    expect(outcome.afterFirst).toEqual({
      patched: false,
      meterProvider: 'NoopMeterProvider',
      tracerProvider: 'NoopTracerProvider',
    });
    expect(outcome.third).toBeNull();
    // The check is not vacuous: a start that went through patches https.
    expect(outcome.afterThird).toEqual(
      expect.objectContaining({ patched: true, tracerProvider: 'TracerProvider' }),
    );
    expect(outcome.exported).toBe(2);
    expect(twice.stdout).not.toMatch(SENTINEL);
    expect(twice.stderr).not.toMatch(SENTINEL);
  });

  it.each(['OTLP http/json', 'OTLP http/protobuf'])(
    'the positive control, %s: every signal is exported to the collector',
    (name) => {
      const run = exportRuns.get(name)!;
      expect({ code: run.code, shutdown: run.outcome.shutdown }).toEqual({
        code: 0,
        shutdown: 'ok',
      });
      const type = name.endsWith('json') ? 'application/json' : 'application/x-protobuf';
      for (const path of EXPECTED_PATHS.http) {
        expect(collectors.http.received).toContain(`POST ${path} ${type}`);
      }
    },
  );

  it('the positive control, OTLP grpc: every signal is exported to the collector', () => {
    const run = exportRuns.get('OTLP grpc')!;
    expect({ code: run.code, shutdown: run.outcome.shutdown }).toEqual({ code: 0, shutdown: 'ok' });
    for (const path of EXPECTED_PATHS.grpc) {
      expect(collectors.grpc.received).toContain(`POST ${path} application/grpc`);
    }
  });

  it('the positive control, Zipkin: spans are exported to the collector', () => {
    const run = exportRuns.get('Zipkin traces')!;
    expect({ code: run.code, shutdown: run.outcome.shutdown }).toEqual({ code: 0, shutdown: 'ok' });
    expect(collectors.http.received).toContain('POST /api/v2/spans application/json');
  });

  it('the positive control, console: every signal is printed', () => {
    const run = exportRuns.get('console')!;
    expect({ code: run.code, shutdown: run.outcome.shutdown }).toEqual({ code: 0, shutdown: 'ok' });
    for (const what of ['boundary-span-0', 'boundary_counter', 'boundary-log-record']) {
      expect(run.stdout).toContain(what);
    }
  });

  it.each([
    'failing OTLP http/json',
    'failing OTLP http/protobuf',
    'failing OTLP grpc',
    'failing Zipkin',
  ])('%s: a failed export and shutdown report nothing of either sentinel', (name) => {
    const run = exportRuns.get(name)!;
    expect(run.code).toBe(0);
    const { shutdown } = run.outcome as { shutdown: 'ok' | { failed: string } };
    if (shutdown !== 'ok') expect(shutdown.failed).toContain(TELEMETRY_SHUTDOWN_FAILED);
    // The collector was reached: the failure is the collector's answer.
    const collector = name.includes('grpc') ? collectors.failingGrpc : collectors.failingHttp;
    expect(collector.received.length).toBeGreaterThan(0);
    expect(run.stdout).not.toMatch(SENTINEL);
    expect(run.stderr).not.toMatch(SENTINEL);
    for (const line of run.stderr.split('\n').filter(Boolean)) {
      expect(line).toMatch(/^\[telemetry\] (ERROR|WARN|INFO|DEBUG|VERBOSE) /);
    }
  });
});
