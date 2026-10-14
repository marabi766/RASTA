import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { RedactingSpanProcessor, redactText, urlWithoutQuery } from './url-redaction';

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

describe('redactText', () => {
  it.each([
    // V8's JSON.parse message, short and long, quoting the body.
    [
      `Unexpected token '/', "/?code=abc" is not valid JSON`,
      `Unexpected token '/', "[REDACTED]" is not valid JSON`,
    ],
    [
      `Unexpected token 'c', "code=abc" is not valid JSON`,
      `Unexpected token 'c', "[REDACTED]" is not valid JSON`,
    ],
    [
      `Unexpected token 'x', ..."a": 1, "abc"... is not valid JSON`,
      `Unexpected token 'x', "[REDACTED]" is not valid JSON`,
    ],
    // A body that repeats the phrase is still taken whole.
    [
      `Unexpected token 'a', "a" is not valid JSON abc" is not valid JSON`,
      `Unexpected token 'a', "[REDACTED]" is not valid JSON`,
    ],
    // The same line opening a stack trace; the frames stay.
    [
      `SyntaxError: Unexpected token 'c', "code=abc" is not valid JSON\n    at JSON.parse (<anonymous>)`,
      `SyntaxError: Unexpected token 'c', "[REDACTED]" is not valid JSON\n    at JSON.parse (<anonymous>)`,
    ],
    // A body over several lines, by any line terminator (Codex on #261, r2 F1).
    ...['\n', '\r\n', '\r', '\u2028', '\u2029'].map((eol): [string, string] => [
      `SyntaxError: Unexpected token 'c', "code=abc${eol}rest${eol}" is not valid JSON\n    at JSON.parse (<anonymous>)`,
      `SyntaxError: Unexpected token 'c', "[REDACTED]" is not valid JSON\n    at JSON.parse (<anonymous>)`,
    ]),
    [
      `Unexpected token 'x', ..."a": 1,\n"abc"... is not valid JSON`,
      `Unexpected token 'x', "[REDACTED]" is not valid JSON`,
    ],
    // A URL in an error message, with a query of pairs or a bare token.
    [
      'GET https://idp.example/cb?code=abc&state=x failed',
      'GET https://idp.example/cb?[REDACTED] failed',
    ],
    ['request to /v1/x?abc failed', 'request to /v1/x?[REDACTED] failed'],
    [`"/v1/x?cursor=abc"`, `"/v1/x?[REDACTED]"`],
    ['at h (/app/x.js?v=abc:1:2)', 'at h (/app/x.js?[REDACTED]'],
    // Not a query: left alone.
    ['Is the connection open?', 'Is the connection open?'],
    ['Is it open? No', 'Is it open? No'],
    ['WHERE a = ? AND b IN (?, ?)', 'WHERE a = ? AND b IN (?, ?)'],
    ['connect ECONNREFUSED 127.0.0.1:5432', 'connect ECONNREFUSED 127.0.0.1:5432'],
  ])('%j → %j', (text, expected) => {
    expect(redactText(text)).toBe(expected);
  });
});

describe('RedactingSpanProcessor', () => {
  it('rewrites URL attributes set at start and later, drops url.query, keeps the rest', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new RedactingSpanProcessor(), new SimpleSpanProcessor(exporter)],
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

  it('sanitizes recorded exceptions, the status message, other attributes, events and links', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new RedactingSpanProcessor(), new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer('test');
    const linked = tracer.startSpan('linked');
    linked.end();
    const span = tracer.startSpan('middleware - jsonParser', {
      links: [{ context: linked.spanContext(), attributes: { 'peer.url': '/cb?code=abc' } }],
    });
    const error = new SyntaxError(`Unexpected token '/', "/?code=abc" is not valid JSON`);
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.addEvent('retry', { 'http.request.target': ['/v1/x?cursor=abc', '/v1/y'], attempt: 2 });
    span.setAttributes({
      'error.detail': 'GET /v1/x?cursor=abc',
      'http.response.status_code': 400,
    });
    span.end();
    await provider.forceFlush();

    const exported = exporter.getFinishedSpans().find((s) => s.name === 'middleware - jsonParser');
    const { attributes, events, links, status } = exported ?? {};
    expect(JSON.stringify({ attributes, events, links, status })).not.toContain('abc');
    const redacted = `Unexpected token '/', "[REDACTED]" is not valid JSON`;
    expect(exported?.status).toEqual({ code: SpanStatusCode.ERROR, message: redacted });
    const [exception, retry] = exported?.events ?? [];
    expect(exception?.attributes).toMatchObject({
      'exception.type': 'SyntaxError',
      'exception.message': redacted,
    });
    expect(exception?.attributes?.['exception.stacktrace']).toMatch(
      new RegExp(`^SyntaxError: ${redacted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n\\s+at `),
    );
    expect(retry?.attributes).toEqual({
      'http.request.target': ['/v1/x?[REDACTED]', '/v1/y'],
      attempt: 2,
    });
    expect(exported?.attributes).toEqual({
      'error.detail': 'GET /v1/x?[REDACTED]',
      'http.response.status_code': 400,
    });
    expect(exported?.links[0]?.attributes).toEqual({ 'peer.url': '/cb?[REDACTED]' });
  });

  it('leaves an OK or unset status as it is', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new RedactingSpanProcessor(), new SimpleSpanProcessor(exporter)],
    });
    const ok = provider.getTracer('test').startSpan('ok');
    ok.setStatus({ code: SpanStatusCode.OK });
    ok.end();
    provider.getTracer('test').startSpan('unset').end();
    await provider.forceFlush();

    expect(exporter.getFinishedSpans().map((s) => s.status)).toEqual([
      { code: SpanStatusCode.OK },
      { code: SpanStatusCode.UNSET },
    ]);
  });

  it('sanitizes each value whole, before attributeValueLengthLimit cuts it (r2 F1)', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanLimits: { attributeValueLengthLimit: 40 },
      spanProcessors: [new RedactingSpanProcessor(), new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer('test');
    const linked = tracer.startSpan('linked');
    linked.end();
    const span = tracer.startSpan('middleware - jsonParser');
    // Cut to 40 characters, this message loses its closing `" is not valid
    // JSON` and keeps the body: `Unexpected token 'c', "code=abc` + newline.
    const error = new SyntaxError(`Unexpected token 'c', "code=abc\nrest" is not valid JSON`);
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.setAttribute('error.detail', `Unexpected token 'c', "code=abc" is not valid JSON`);
    span.addEvent('retry', {
      'error.detail': `Unexpected token 'c', "code=abc" is not valid JSON`,
    });
    span.addLink({
      context: linked.spanContext(),
      attributes: { 'error.detail': `Unexpected token 'c', "code=abc" is not valid JSON` },
    });
    span.end();
    await provider.forceFlush();

    const exported = exporter.getFinishedSpans().find((s) => s.name === 'middleware - jsonParser');
    const { attributes, events, links, status } = exported ?? {};
    expect(JSON.stringify({ attributes, events, links, status })).not.toContain('abc');
    const redacted = `Unexpected token 'c', "[REDACTED]" is not valid JSON`;
    const cut = redacted.slice(0, 40);
    expect(cut).toBe(`Unexpected token 'c', "[REDACTED]" is no`);
    // The SDK does not cut a status message.
    expect(exported?.status).toEqual({ code: SpanStatusCode.ERROR, message: redacted });
    const [exception, retry] = exported?.events ?? [];
    expect(exception?.attributes).toEqual({
      'exception.type': 'SyntaxError',
      'exception.message': cut,
      'exception.stacktrace': `SyntaxError: ${redacted}`.slice(0, 40),
    });
    expect(retry?.attributes).toEqual({ 'error.detail': cut });
    expect(exported?.attributes).toEqual({ 'error.detail': cut });
    expect(exported?.links[0]?.attributes).toEqual({ 'error.detail': cut });
  });
});

interface ExportedSpan {
  name: string;
  kind: SpanKind;
  scope: string;
  attributes: Record<string, unknown>;
  events: { name: string; attributes?: Record<string, unknown> }[];
  status: { code: SpanStatusCode; message?: string };
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

interface FixtureResult {
  origin: string;
  refused: string;
  spans: ExportedSpan[];
}

/** Runs the fixture with no `OTEL_*` variable from this process, plus `env`. */
async function runFixture(env: Record<string, string> = {}): Promise<FixtureResult> {
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', RUN_FIXTURE], {
    cwd: PACKAGE_DIR,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('OTEL_')),
      ),
      ...env,
    },
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as FixtureResult;
}

/** The middleware spans of the bodies the JSON parser refused, in the order sent. */
const parserSpans = (spans: ExportedSpan[]): ExportedSpan[] =>
  spans.filter(
    (span) =>
      span.scope === '@opentelemetry/instrumentation-express' &&
      span.name === 'middleware - jsonParser' &&
      span.status.code === SpanStatusCode.ERROR,
  );

/** What the parser errors read once redacted, in the order the bodies were sent. */
const REDACTED_PARSER_ERRORS = ['/', 'c', 'c', 'c', 'c', 'c', 'c'].map(
  (token) => `Unexpected token '${token}', "[REDACTED]" is not valid JSON`,
);

const exceptionMessages = (span: ExportedSpan | undefined): unknown[] =>
  (span?.events ?? [])
    .filter((event) => event.name === 'exception')
    .map((event) => event.attributes?.['exception.message']);

describe('initTelemetry — spans from the real instrumentations carry no URL query', () => {
  let origin: string;
  let refused: string;
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
    ({ origin, refused, spans } = await runFixture());
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

  it('a JSON body the parser refuses, on one line or several: the exception and status stay, the quoted body does not', () => {
    const parsers = parserSpans(spans);
    expect(parsers.map((span) => span.status.message)).toEqual(REDACTED_PARSER_ERRORS);
    expect(parsers.map((span) => exceptionMessages(span))).toEqual(
      REDACTED_PARSER_ERRORS.map((m) => [m]),
    );
    for (const span of parsers) {
      const [exception] = span.events;
      expect(exception?.attributes?.['exception.stacktrace']).toMatch(
        /^SyntaxError: Unexpected token '.', "\[REDACTED\]" is not valid JSON\n\s+at JSON\.parse/,
      );
    }
  });

  it('a handler error naming a URL: its exception and status keep the URL up to the path', () => {
    const [handler] = find(
      '@opentelemetry/instrumentation-nestjs-core',
      SpanKind.INTERNAL,
      '/v1/fail',
    );
    const message = 'GET https://idp.example/cb?[REDACTED] failed';
    expect(handler?.name).toBe('XController.fail');
    expect(handler?.status).toEqual({ code: SpanStatusCode.ERROR, message });
    expect(exceptionMessages(handler)).toEqual([message]);
  });

  it('a failed outgoing fetch: the error is recorded, url.full has no query', () => {
    const [failed] = spans.filter(
      (span) =>
        span.scope === '@opentelemetry/instrumentation-undici' &&
        span.attributes['url.full'] === `${refused}/v1/x`,
    );
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
    expect(exceptionMessages(failed)).toEqual([expect.stringContaining('ECONNREFUSED')]);
    expect(failed?.attributes).not.toHaveProperty(['url.query']);
  });
});

describe('initTelemetry under OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT=40 — a cut value carries nothing either (r2 F1)', () => {
  const LIMIT = 40;
  let spans: ExportedSpan[];

  beforeAll(async () => {
    ({ spans } = await runFixture({ OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: String(LIMIT) }));
  }, CHILD_TIMEOUT_MS + 5_000);

  it('the limit is in force', () => {
    const lengths = spans.flatMap((span) => [
      ...Object.values(span.attributes),
      ...span.events.flatMap((event) => Object.values(event.attributes ?? {})),
    ]);
    expect(lengths.filter((value) => typeof value === 'string' && value.length > LIMIT)).toEqual(
      [],
    );
  });

  it('no exported span holds "abc"', () => {
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.filter((span) => JSON.stringify(span).includes('abc'))).toEqual([]);
  });

  it('the parser errors are recorded, redacted whole and then cut', () => {
    const parsers = parserSpans(spans);
    expect(parsers.map((span) => span.status.message)).toEqual(REDACTED_PARSER_ERRORS);
    expect(parsers.map((span) => exceptionMessages(span))).toEqual(
      REDACTED_PARSER_ERRORS.map((m) => [m.slice(0, LIMIT)]),
    );
  });
});
