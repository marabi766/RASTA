/**
 * The child-process half of `url-redaction.spec.ts`.
 *
 * The instrumentations patch modules through Node's own `require`, which jest's
 * module loader bypasses: under jest, `@nestjs/core` is never instrumented and
 * a NestJS span could not leak — or prove that it no longer does. So the spec
 * runs this file in a plain Node process, compiled by SWC, and reads the
 * finished spans from its stdout as JSON.
 *
 * The order is a service's `main.ts`: `initTelemetry` first, the framework
 * loaded after it. Every request carries "abc" — in its query, in a body the
 * JSON parser refuses, in the URL an error names, in a header the server span
 * starts with. The spec runs it twice: with
 * no span limits, and with `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT=40`.
 */
import type * as NodeHttp from 'node:http';
import { trace, type ProxyTracerProvider } from '@opentelemetry/api';
import { InMemorySpanExporter, type NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { initTelemetry } from '../telemetry';

const QUERY = '?secret=abc';

/** The JSON bodies sent, in order; the spec expects their parser errors in this order. */
const PARSER_BODIES = [
  '/?code=abc',
  'code=abc',
  'code=abc\nrest',
  'code=abc\r\nrest',
  'code=abc\rrest',
  'code=abc\u2028rest',
  'code=abc\u2029rest',
];

/**
 * Caller-controlled headers that become start attributes of the server span:
 * `server.address` (`X-Forwarded-Host`) and `client.address`
 * (`X-Forwarded-For`); and the user agent, which is never recorded (Codex on
 * #261, r4 L1: a raw space inside its query). The forwarded host is shaped
 * like a parser error, so a cut before redaction would keep "abc".
 */
const START_ATTRIBUTE_HEADERS = {
  'user-agent': 'GET /cb?q=a b&access_token=abc',
  'x-forwarded-host': `Unexpected token 'c', "code=abc" is not valid JSON`,
  'x-forwarded-for': '[/cb?code=abc',
};

/** Under Node's 16 KiB header limit, over `REDACT_TEXT_MAX` (Codex on #261, r4 F1). */
const LONG = 15_000;

/**
 * Requests whose start attributes are as long as a header makes them, each
 * shaped against one redaction rule: no URL at all, quotes only, `?` after a
 * word, `/` only. `/v1/headers/<case>` tells their server spans apart.
 */
const LONG_HEADER_REQUESTS: Record<string, Record<string, string>> = {
  'user-agent': { 'user-agent': 'a'.repeat(LONG) },
  quotes: { 'x-forwarded-host': '"'.repeat(LONG) },
  // `[` first: not an address, so the instrumentation records it as it came.
  questions: { 'x-forwarded-for': `[${'a?'.repeat(LONG / 2)}` },
  slashes: { 'x-forwarded-host': '/'.repeat(LONG) },
};

/** A request target as long as a request line makes it: `url.path`. */
const LONG_PATH = `/v1/long/${'a'.repeat(LONG)}`;

/** An origin nothing listens on: a port bound, then released. */
async function refusingOrigin(http: typeof NodeHttp): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

async function main(): Promise<void> {
  const exporter = new InMemorySpanExporter();
  initTelemetry({ serviceName: 'url-query-fixture', traceExporter: exporter });

  await import('reflect-metadata');
  const { Controller, Get, Module, Post } = await import('@nestjs/common');
  const { NestFactory } = await import('@nestjs/core');
  const http = await import('node:http');

  @Controller('v1')
  class XController {
    @Get('x')
    x(): { ok: boolean } {
      return { ok: true };
    }

    @Post('x')
    post(): { ok: boolean } {
      return { ok: true };
    }

    @Get(['headers', 'headers/:case'])
    headers(): { ok: boolean } {
      return { ok: true };
    }

    // A failure whose message names the URL it was working on, query and all —
    // the shape of an HTTP client's or an OAuth library's error.
    @Get('fail')
    fail(): never {
      throw new Error(`GET https://idp.example/cb${QUERY} failed`);
    }
  }

  @Module({ controllers: [XController] })
  class AppModule {}

  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();

  // An outgoing fetch (undici) that is also the incoming request to Nest.
  await (await fetch(`${origin}/v1/x${QUERY}`)).text();
  // The same through node:http, the http instrumentation's client side.
  await new Promise<void>((resolve, reject) => {
    http
      .get(`${origin}/v1/x${QUERY}`, (response) => {
        response.resume();
        response.on('end', resolve);
      })
      .on('error', reject);
  });
  const get = (path: string, headers: Record<string, string>): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      http
        .get(`${origin}${path}`, { headers }, (response) => {
          response.resume();
          response.on('end', resolve);
        })
        .on('error', reject);
    });
  // Headers the http instrumentation copies into the server span's start
  // attributes, which the SDK cuts before any span processor sees them (r3 F2).
  await get('/v1/headers', START_ATTRIBUTE_HEADERS);
  // The same, as long as a header can be, and a path as long (r4 F1).
  for (const [name, headers] of Object.entries(LONG_HEADER_REQUESTS)) {
    await get(`/v1/headers/${name}`, headers);
  }
  await get(LONG_PATH, {});
  // No route: Nest's own 404 handler.
  await (await fetch(`${origin}/v1/missing${QUERY}`)).text();
  // Bodies Express's instrumented JSON parser refuses: V8's message quotes
  // them, and the instrumentation records it as the middleware span's exception
  // and status. One looks like a query (Codex on #261, F1), one does not, and
  // the rest run over two lines, by each line terminator (r2 F1).
  for (const body of PARSER_BODIES) {
    await (
      await fetch(`${origin}/v1/x`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
    ).text();
  }
  // A handler that throws with the URL in its message.
  await (await fetch(`${origin}/v1/fail`)).text();
  // An outgoing request that fails: the client span records the error.
  const refused = await refusingOrigin(http);
  await fetch(`${refused}/v1/x${QUERY}`).then(
    () => undefined,
    () => undefined,
  );

  await app.close();
  const provider = (trace.getTracerProvider() as ProxyTracerProvider).getDelegate();
  await (provider as NodeTracerProvider).forceFlush();

  const spans = exporter.getFinishedSpans().map((span) => ({
    name: span.name,
    kind: span.kind,
    scope: span.instrumentationScope.name,
    attributes: span.attributes,
    events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
    status: span.status,
  }));
  // Written out before `process.exit` runs: a pipe can take less than a write in one go.
  await new Promise<void>((resolve) => {
    process.stdout.write(JSON.stringify({ origin, refused, spans }), () => resolve());
  });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
