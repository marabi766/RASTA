import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createH2Server, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * `initTelemetry` puts the redacting span processor in front of the exporting
 * ones, and that must not change which exporter runs (Codex on #261, F3). Each
 * case starts telemetry twice under one environment — once as the code before
 * #261 did, once as `initTelemetry` does now — and compares what reached the
 * exporters: OTLP requests by path and content type (so by protocol), console
 * prints, whether spans were recorded at all. Then, wherever spans were
 * exported, that the current code exported them without the query.
 */

const PACKAGE_DIR = resolve(__dirname, '..');
const FIXTURE = resolve(__dirname, '__tests__/exporter-selection.fixture.ts');
const SWC_OPTIONS = resolve(PACKAGE_DIR, '../../jest.swc.cjs');
const CHILD_TIMEOUT_MS = 60_000;
/** Children started at once; each loads the SDK and, for `current`, every instrumentation. */
const CONCURRENCY = 4;
/** Bounds an export the collector somehow does not answer; the OTLP default is 10 s. */
const EXPORT_TIMEOUT_MS = '5000';
/**
 * The query value the fixture's spans carry. Not hex, and long: an OTLP/JSON
 * export spells trace and span ids in hex, where a short hex-like value (`abc`)
 * turns up by chance.
 */
const SECRET = 'QUERY_LEAK_SENTINEL';

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

interface Export {
  path: string;
  contentType: string;
  /** Whether the exported bytes contain the query value. */
  leaked: boolean;
  /** Whether they hold the span processors' own SDK metrics. */
  processorMetrics: boolean;
}

const isTraceExport = (e: Export): boolean => /trace/i.test(e.path);

interface Outcome {
  recording: boolean;
  exports: Export[];
  /** One entry per span the console exporter printed: whether it held the query value. */
  printed: boolean[];
  /** Why shutdown — the final flush of every exporter — failed, if it did. */
  shutdownError?: string;
}

/** An OTLP collector on loopback: HTTP (protobuf and JSON) and gRPC over h2c. */
class Collector {
  readonly exports: Export[] = [];
  private readonly http: Server;
  private readonly grpc: Http2Server;

  constructor() {
    this.http = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        this.record(request.url ?? '', request.headers['content-type'], chunks);
        response.writeHead(200, { 'content-type': request.headers['content-type'] ?? '' });
        response.end(request.headers['content-type'] === 'application/json' ? '{}' : '');
      });
    });
    this.grpc = createH2Server();
    this.grpc.on('stream', (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        this.record(String(headers[':path']), headers['content-type'], chunks);
        stream.respond(
          { ':status': 200, 'content-type': 'application/grpc' },
          { waitForTrailers: true },
        );
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        // One empty, uncompressed message: an ExportTraceServiceResponse.
        stream.end(Buffer.alloc(5));
      });
    });
  }

  async start(): Promise<{ http: string; grpc: string }> {
    await new Promise<void>((done) => this.http.listen(0, '127.0.0.1', done));
    await new Promise<void>((done) => this.grpc.listen(0, '127.0.0.1', done));
    const port = (server: Server | Http2Server): number => (server.address() as AddressInfo).port;
    return {
      http: `http://127.0.0.1:${port(this.http)}`,
      grpc: `http://127.0.0.1:${port(this.grpc)}`,
    };
  }

  close(): void {
    this.http.closeAllConnections();
    this.http.close();
    this.grpc.close();
  }

  private record(path: string, contentType: string | undefined, chunks: Buffer[]): void {
    const body = Buffer.concat(chunks);
    this.exports.push({
      path,
      contentType: contentType ?? '',
      leaked: body.includes(SECRET),
      processorMetrics: body.includes('otel.sdk.processor.span'),
    });
  }
}

type Mode = 'baseline' | 'current';

interface Case {
  name: string;
  /** `OTEL_*` variables; `HTTP` and `GRPC` stand for the collector's origins. */
  env: Record<string, string>;
  /** Pass the HTTP collector as `otlpEndpoint`, as every service's main.ts does. */
  explicitEndpoint?: boolean;
}

const CASES: Case[] = [
  {
    name: 'no endpoint, defaults: OTLP http/protobuf',
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'HTTP' },
  },
  {
    name: 'no endpoint, OTEL_TRACES_EXPORTER=none: no tracer provider',
    env: { OTEL_TRACES_EXPORTER: 'none', OTEL_EXPORTER_OTLP_ENDPOINT: 'HTTP' },
  },
  { name: 'no endpoint, OTEL_TRACES_EXPORTER=console', env: { OTEL_TRACES_EXPORTER: 'console' } },
  {
    name: 'no endpoint, OTEL_TRACES_EXPORTER=otlp,console',
    env: { OTEL_TRACES_EXPORTER: 'otlp,console', OTEL_EXPORTER_OTLP_ENDPOINT: 'HTTP' },
  },
  {
    name: 'no endpoint, OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json',
    env: { OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_ENDPOINT: 'HTTP' },
  },
  {
    name: 'no endpoint, OTEL_EXPORTER_OTLP_PROTOCOL=grpc',
    env: { OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc', OTEL_EXPORTER_OTLP_ENDPOINT: 'GRPC' },
  },
  {
    name: 'no endpoint, OTEL_SDK_DISABLED=true',
    env: { OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'HTTP' },
  },
  {
    name: 'explicit endpoint: OTLP http/json there, whatever OTEL_TRACES_EXPORTER says',
    env: { OTEL_TRACES_EXPORTER: 'none' },
    explicitEndpoint: true,
  },
  {
    name: 'explicit endpoint: the batch processor reads OTEL_BSP_*',
    env: { OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '1' },
    explicitEndpoint: true,
  },
  {
    name: 'explicit endpoint, OTEL_NODE_EXPERIMENTAL_SDK_METRICS=true: the processor reports itself',
    env: {
      OTEL_NODE_EXPERIMENTAL_SDK_METRICS: 'true',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'HTTP',
    },
    explicitEndpoint: true,
  },
  {
    name: 'no endpoint, OTEL_NODE_EXPERIMENTAL_SDK_METRICS=true',
    env: {
      OTEL_NODE_EXPERIMENTAL_SDK_METRICS: 'true',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'HTTP',
    },
  },
];

async function run(testCase: Case, mode: Mode): Promise<Outcome> {
  const collector = new Collector();
  const origins = await collector.start();
  try {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('OTEL_')),
      ),
      OTEL_EXPORTER_OTLP_TIMEOUT: EXPORT_TIMEOUT_MS,
      // Their default is OTLP at localhost:4318, whatever listens there on
      // the machine running the test. A case about metrics turns them back on.
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_LOGS_EXPORTER: 'none',
    };
    for (const [key, value] of Object.entries(testCase.env)) {
      env[key] = value === 'HTTP' ? origins.http : value === 'GRPC' ? origins.grpc : value;
    }
    if (testCase.explicitEndpoint) env.FIXTURE_OTLP_ENDPOINT = origins.http;
    const args = ['-e', RUN_FIXTURE, mode];
    const { stdout } = await promisify(execFile)(process.execPath, args, {
      cwd: PACKAGE_DIR,
      env,
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    const { recording, printed, shutdownError } = JSON.parse(stdout) as {
      recording: boolean;
      printed: string[];
      shutdownError?: string;
    };
    return {
      recording,
      exports: collector.exports,
      printed: printed.map((line) => line.includes(SECRET)),
      shutdownError,
    };
  } finally {
    collector.close();
  }
}

/** What identifies the exporters and their protocols, without the redaction result. */
function selection(outcome: Outcome): unknown {
  return {
    recording: outcome.recording,
    exports: outcome.exports
      .map(({ path, contentType, processorMetrics }) =>
        [path, contentType, processorMetrics ? 'processor-metrics' : ''].join(' '),
      )
      .sort(),
    printed: outcome.printed.length,
    shutdownError: outcome.shutdownError,
  };
}

async function inPool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await (tasks[index] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

describe('initTelemetry — exporter selection is what it was before the redacting processor', () => {
  const outcomes = new Map<string, Record<Mode, Outcome>>();

  beforeAll(async () => {
    const tasks = CASES.flatMap((testCase) =>
      (['baseline', 'current'] as const).map((mode) => async (): Promise<[Case, Mode, Outcome]> => [
        testCase,
        mode,
        await run(testCase, mode),
      ]),
    );
    for (const [testCase, mode, outcome] of await inPool(tasks, CONCURRENCY)) {
      outcomes.set(testCase.name, { ...outcomes.get(testCase.name), [mode]: outcome } as Record<
        Mode,
        Outcome
      >);
    }
  }, 4 * CHILD_TIMEOUT_MS);

  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    const { baseline, current } = outcomes.get(testCase.name) as Record<Mode, Outcome>;
    expect(selection(current)).toEqual(selection(baseline));
    // Baseline exports the query wherever it exports spans at all, so the
    // check below is not vacuous; the current code exports none of it.
    const leaks = (outcome: Outcome): boolean[] => [
      ...outcome.exports.filter(isTraceExport).map((e) => e.leaked),
      ...outcome.printed,
    ];
    expect(leaks(baseline)).not.toContain(false);
    expect(leaks(current)).not.toContain(true);
  });

  it('the matrix exercises every exporter kind it names', () => {
    const baseline = (name: string): Outcome =>
      (outcomes.get(name) as Record<Mode, Outcome>).baseline;
    const traceExports = (name: string): Export[] => baseline(name).exports.filter(isTraceExport);
    const contentTypes = CASES.flatMap((c) => traceExports(c.name).map((e) => e.contentType));
    expect(new Set(contentTypes)).toEqual(
      new Set(['application/x-protobuf', 'application/json', 'application/grpc']),
    );
    expect(CASES.some((c) => baseline(c.name).printed.length > 0)).toBe(true);
    expect(CASES.some((c) => !baseline(c.name).recording)).toBe(true);
    expect(traceExports('explicit endpoint: the batch processor reads OTEL_BSP_*')).toHaveLength(2);
    expect(
      baseline(
        'explicit endpoint, OTEL_NODE_EXPERIMENTAL_SDK_METRICS=true: the processor reports itself',
      ).exports.some((e) => e.processorMetrics),
    ).toBe(true);
  });
});
