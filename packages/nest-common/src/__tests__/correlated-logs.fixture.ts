/**
 * The child-process half of `correlated-logs.spec.ts`.
 *
 * A service as `main.ts` and `AppModule` build it — `initTelemetry` first, then
 * the pino logger, `RequestContextMiddleware` on every route and
 * `AllExceptionsFilter` — with in-memory span and log exporters. pino's
 * instrumentation sends each log line through the OTel Logs API with the
 * active span's context: the trace-correlated log records Codex found carrying
 * the query (#261, F2). It runs outside jest because the instrumentations patch
 * modules through Node's own `require`, which jest's loader bypasses.
 *
 * Every request carries "LEAK" in its query and as its correlation id
 * (`x-correlation-id: access_token=LEAK`, r2 F3); some carry it in a body or
 * in the URL an error names (r2 F2), some in a secret an error's text holds
 * past the redaction cap (r5 F1). The logger runs at the level in argv[2];
 * the result is written as JSON to the file named by argv[1] (stdout is the
 * logger's).
 */
import { writeFileSync } from 'node:fs';
import type { MiddlewareConsumer } from '@nestjs/common';
import { trace, type ProxyTracerProvider } from '@opentelemetry/api';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { InMemorySpanExporter, type NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { initTelemetry, shutdownTelemetry } from '@rasta/observability';

const QUERY = '?secret=LEAK';

/** A correlation id that is a token: what a caller may send, and no log may hold. */
const CORRELATION_ID = 'access_token=LEAK';

/** The URLs an OAuth exchange's errors name — the code and state in the query. */
const TOKEN_URL = 'https://idp.example/token?code=LEAK&state=LEAK';
const CALLBACK_URL = 'https://idp.example/cb?access_token=LEAK';

/**
 * URLs whose query or fragment holds "LEAK" past a character that might be
 * taken to end it (r3 F1). Each is named by an error, in its message (where the
 * URL ends the text) and its cause (where text follows), in each of the forms
 * the filter tells apart: a plain `Error`, `RastaError.internal`, and Nest's
 * `BadGatewayException`.
 */
const URL_VARIANTS = {
  apostrophe: "https://idp.example/cb?state=can't&access_token=LEAK",
  fragment: 'https://idp.example/cb#access_token=LEAK',
  quoted: 'https://idp.example/cb?q="LEAK"&r=[LEAK]&s=<LEAK>&t={LEAK}&u=`LEAK`',
  unicode: 'https://idp.example/cb?q=مسیر&r=café‽LEAK',
  path: "/v1/cb?state=can't#LEAK",
} as const;

const ERROR_FORMS = ['plain', 'internal', 'gateway'] as const;

/** Prose with a question in it: no URL, nothing to take out. */
const PROSE = 'Is the ledger ready? Not yet; retry later?';

/**
 * Errors whose secret runs past the cap on what is redacted (4096 characters,
 * Codex on #261, r5 F1): the cut goes through it, so what marks it — a
 * connection string's `@`, a body's closing phrase — is past the cut. Thrown
 * with a cause of the same text.
 */
const SECRET = `LEAK${'_LEAK'.repeat(1_000)}`;
const CUT_MESSAGES = {
  credentials: `connect ECONNREFUSED postgresql://app:${SECRET}@db/app`,
  bearer: `upstream said: Authorization: Bearer ${SECRET}`,
  password: `POST https://idp.example/token?password=${SECRET}`,
  quoted: `Unexpected token 'p', "password=${SECRET}" is not valid JSON`,
} as const;

async function main(): Promise<void> {
  const [outputFile, level = 'debug'] = process.argv.slice(1);
  const spanExporter = new InMemorySpanExporter();
  const logExporter = new InMemoryLogRecordExporter();
  initTelemetry({
    serviceName: 'correlated-logs-fixture',
    traceExporter: spanExporter,
    logRecordExporter: logExporter,
  });

  await import('reflect-metadata');
  const { BadGatewayException, Controller, Get, Module, Param, Post } =
    await import('@nestjs/common');
  const { APP_FILTER, NestFactory } = await import('@nestjs/core');
  const { createLogger, setLogContextProvider } = await import('@rasta/logging');
  const { RequestContextMiddleware } = await import('../middleware/request-context.middleware');
  const { AllExceptionsFilter, EXCEPTION_FILTER_LOGGER } =
    await import('../filters/exception.filter');
  const { RastaError } = await import('../errors/rasta-error');
  const { toLogContext } = await import('../context/request-context');

  const logger = createLogger({
    serviceName: 'correlated-logs-fixture',
    level,
    pretty: false,
  });
  setLogContextProvider(() => toLogContext());

  @Controller('v1')
  class AssetsController {
    // A refusal: the filter logs it at warn (the trigger in Codex's report).
    @Get('assets')
    list(): never {
      throw RastaError.forbidden();
    }

    // A body the JSON parser refuses never reaches this; the filter logs at debug.
    @Post('assets')
    create(): { ok: boolean } {
      return { ok: true };
    }

    // An unrecognised failure: the filter logs at error.
    @Get('boom')
    boom(): never {
      throw new Error('boom');
    }

    // Failures whose message, and whose cause's, name a URL with its query —
    // an OAuth library's errors. Logged at error, with `originalMessage`.
    @Get('oauth')
    oauth(): never {
      throw new Error(`Token exchange failed: POST ${TOKEN_URL}`, {
        cause: new Error(`GET ${CALLBACK_URL} refused`),
      });
    }

    @Get('oauth-internal')
    oauthInternal(): never {
      throw RastaError.internal(
        `Token exchange failed: POST ${TOKEN_URL}`,
        new Error(`GET ${CALLBACK_URL} refused`),
      );
    }

    @Get('oauth-gateway')
    oauthGateway(): never {
      throw new BadGatewayException(`Token exchange failed: POST ${TOKEN_URL}`);
    }

    @Get('url/:form/:variant')
    url(@Param('form') form: string, @Param('variant') variant: string): never {
      const url = URL_VARIANTS[variant as keyof typeof URL_VARIANTS];
      const message = `Token exchange failed: POST ${url}`;
      const cause = new Error(`GET ${url} refused`);
      if (form === 'internal') throw RastaError.internal(message, cause);
      if (form === 'gateway') throw new BadGatewayException(message, { cause });
      throw new Error(message, { cause });
    }

    @Get('prose')
    prose(): never {
      throw new Error(PROSE);
    }

    @Get('cut/:kind')
    cut(@Param('kind') kind: string): never {
      const message = CUT_MESSAGES[kind as keyof typeof CUT_MESSAGES];
      throw new Error(message, { cause: new Error(message) });
    }
  }

  @Module({
    controllers: [AssetsController],
    providers: [
      { provide: EXCEPTION_FILTER_LOGGER, useValue: logger },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  })
  class AppModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer.apply(RequestContextMiddleware).forRoutes('*');
    }
  }

  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();

  const statuses: number[] = [];
  // The correlation id each response carries: the one the request was logged under.
  const correlationIds: (string | null)[] = [];
  const send = async (
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<void> => {
    const response = await fetch(`${origin}${path}${QUERY}`, {
      ...init,
      headers: { ...init?.headers, 'x-correlation-id': CORRELATION_ID },
    });
    await response.text();
    statuses.push(response.status);
    correlationIds.push(response.headers.get('x-correlation-id'));
  };
  const postJson = (body: string) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  await send('/v1/assets');
  await send('/v1/assets', postJson('{'));
  await send('/v1/assets', postJson('code=LEAK\nrest'));
  await send('/v1/boom');
  // No route: Nest's own fallback, `Cannot GET /v1/missing?secret=LEAK`.
  await send('/v1/missing');
  await send('/v1/oauth');
  await send('/v1/oauth-internal');
  await send('/v1/oauth-gateway');
  for (const form of ERROR_FORMS) {
    for (const variant of Object.keys(URL_VARIANTS)) await send(`/v1/url/${form}/${variant}`);
  }
  await send('/v1/prose');
  for (const kind of Object.keys(CUT_MESSAGES)) await send(`/v1/cut/${kind}`);

  await app.close();
  // Read before shutdown, which empties the in-memory exporters. Log records
  // go out as they are emitted (a simple processor); spans wait for a flush.
  const provider = (trace.getTracerProvider() as ProxyTracerProvider).getDelegate();
  await (provider as NodeTracerProvider).forceFlush();

  const spanIds = new Set(spanExporter.getFinishedSpans().map((span) => span.spanContext().spanId));
  const logs = logExporter.getFinishedLogRecords().map((record) => ({
    severityText: record.severityText,
    body: record.body,
    attributes: record.attributes,
    // Whether the record is stitched to a span this process exported.
    correlated: record.spanContext !== undefined && spanIds.has(record.spanContext.spanId),
  }));
  const spans = spanExporter.getFinishedSpans().map((span) => ({
    name: span.name,
    scope: span.instrumentationScope.name,
    attributes: span.attributes,
    events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
    status: span.status,
  }));
  writeFileSync(outputFile as string, JSON.stringify({ statuses, correlationIds, logs, spans }));
  await shutdownTelemetry();
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
