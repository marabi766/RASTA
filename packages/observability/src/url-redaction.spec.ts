import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { SpanKind } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { UrlQueryRedactingSpanProcessor, urlWithoutQuery } from './url-redaction';

describe('urlWithoutQuery', () => {
  it.each([
    ['https://idp.example/cb?code=abc&state=x', 'https://idp.example/cb'],
    ['/v1/x?cursor=abc', '/v1/x'],
    ['/v1/x#abc', '/v1/x'],
    ['/v1/x?', '/v1/x'],
    ['/v1/x', '/v1/x'],
  ])('%s → %s', (url, expected) => {
    expect(urlWithoutQuery(url)).toBe(expected);
  });
});

describe('UrlQueryRedactingSpanProcessor', () => {
  it('rewrites URL attributes set at start and later, drops url.query, keeps the rest', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new UrlQueryRedactingSpanProcessor(), new SimpleSpanProcessor(exporter)],
    });
    const span = provider.getTracer('test').startSpan('GET /v1/x/:id', {
      attributes: {
        'url.full': 'https://h.example/v1/x/1?cursor=abc#f',
        'url.query': 'cursor=abc',
      },
    });
    span.setAttributes({
      'http.url': 'http://h.example/v1/x/1?q=abc',
      'http.target': '/v1/x/1?q=abc',
      'url.path': '/v1/x/1',
      'http.route': '/v1/x/:id',
    });
    span.end();
    await provider.forceFlush();

    const [exported] = exporter.getFinishedSpans();
    expect(exported?.name).toBe('GET /v1/x/:id');
    expect(exported?.attributes).toEqual({
      'url.full': 'https://h.example/v1/x/1',
      'http.url': 'http://h.example/v1/x/1',
      'http.target': '/v1/x/1',
      'url.path': '/v1/x/1',
      'http.route': '/v1/x/:id',
    });
  });
});

interface ExportedSpan {
  name: string;
  kind: SpanKind;
  scope: string;
  attributes: Record<string, unknown>;
  events: unknown[];
  status: unknown;
}

const PACKAGE_DIR = resolve(__dirname, '..');
const FIXTURE = resolve(__dirname, '__tests__/url-query-spans.fixture.ts');
const SWC_OPTIONS = resolve(PACKAGE_DIR, '../../jest.swc.cjs');
const CHILD_TIMEOUT_MS = 60_000;

/** Compiles `.ts` with the jest SWC options, then runs the fixture. */
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

describe('initTelemetry — spans from the real instrumentations carry no URL query', () => {
  let origin: string;
  let spans: ExportedSpan[];

  const find = (scope: string, kind: SpanKind, path: string): ExportedSpan[] =>
    spans.filter(
      (span) =>
        span.scope === scope &&
        span.kind === kind &&
        [span.attributes['url.path'], span.attributes['url.full']].some(
          (url) => url === path || url === `${origin}${path}`,
        ),
    );

  beforeAll(async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('OTEL_')),
    );
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', RUN_FIXTURE], {
      cwd: PACKAGE_DIR,
      env,
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    ({ origin, spans } = JSON.parse(stdout) as { origin: string; spans: ExportedSpan[] });
  }, CHILD_TIMEOUT_MS + 5_000);

  it('no exported span holds "abc" — name, attribute, event or status', () => {
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.filter((span) => JSON.stringify(span).includes('abc'))).toEqual([]);
  });

  it('incoming GET /v1/x?secret=abc: the server span keeps path and name, without url.query', () => {
    const [server] = find('@opentelemetry/instrumentation-http', SpanKind.SERVER, '/v1/x');
    expect(server?.name).toBe('GET /v1/x');
    expect(server?.attributes).toMatchObject({ 'url.path': '/v1/x', 'http.route': '/v1/x' });
    expect(server?.attributes).not.toHaveProperty(['url.query']);
  });

  it('the NestJS handler span keeps its route template, url.full is the bare path', () => {
    const [handler] = find(
      '@opentelemetry/instrumentation-nestjs-core',
      SpanKind.INTERNAL,
      '/v1/x',
    );
    expect(handler?.name).toBe('XController.x');
    expect(handler?.attributes).toMatchObject({ 'url.full': '/v1/x', 'http.route': '/v1/x' });
  });

  it('outgoing fetch and node:http keep the URL up to the path', () => {
    const [fetchSpan] = find('@opentelemetry/instrumentation-undici', SpanKind.CLIENT, '/v1/x');
    expect(fetchSpan?.name).toBe('GET');
    expect(fetchSpan?.attributes).toMatchObject({
      'url.full': `${origin}/v1/x`,
      'url.path': '/v1/x',
    });
    expect(fetchSpan?.attributes).not.toHaveProperty(['url.query']);

    const [httpClient] = find('@opentelemetry/instrumentation-http', SpanKind.CLIENT, '/v1/x');
    expect(httpClient?.name).toBe('GET');
    expect(httpClient?.attributes).toMatchObject({ 'url.full': `${origin}/v1/x` });
  });

  it("Nest's 404 for an unknown route: the server span has the path only", () => {
    const [server] = find('@opentelemetry/instrumentation-http', SpanKind.SERVER, '/v1/missing');
    expect(server?.attributes).toMatchObject({
      'url.path': '/v1/missing',
      'http.response.status_code': 404,
    });
    expect(server?.attributes).not.toHaveProperty(['url.query']);
  });
});
