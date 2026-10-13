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
 * loaded after it. Every request carries `secret=abc` in its query.
 */
import { trace, type ProxyTracerProvider } from '@opentelemetry/api';
import { InMemorySpanExporter, type NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { initTelemetry } from '../telemetry';

const QUERY = '?secret=abc';

async function main(): Promise<void> {
  const exporter = new InMemorySpanExporter();
  initTelemetry({ serviceName: 'url-query-fixture', traceExporter: exporter });

  await import('reflect-metadata');
  const { Controller, Get, Module } = await import('@nestjs/common');
  const { NestFactory } = await import('@nestjs/core');
  const http = await import('node:http');

  @Controller('v1')
  class XController {
    @Get('x')
    x(): { ok: boolean } {
      return { ok: true };
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
  // No route: Nest's own 404 handler.
  await (await fetch(`${origin}/v1/missing${QUERY}`)).text();

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
  process.stdout.write(JSON.stringify({ origin, spans }));
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
