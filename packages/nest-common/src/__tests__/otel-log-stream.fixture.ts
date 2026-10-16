/**
 * The child-process half of `otel-log-stream.spec.ts`.
 *
 * The real `initTelemetry()` — so pino's instrumentation really replaces the
 * logger's stream with a multistream that also feeds the OTel Logs API — and
 * the real `createLogger()`, with an in-memory log exporter. Writes the lines
 * the configured destination received and the log records the exporter
 * received as JSON to the file named by argv[1] (Codex on #290, r4 F1). It runs
 * outside jest because the instrumentation patches modules through Node's own
 * `require`, which jest's loader bypasses.
 */
import { writeFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { initTelemetry, shutdownTelemetry } from '@rasta/observability';

async function main(): Promise<void> {
  const outputFile = process.argv[1] as string;
  const logExporter = new InMemoryLogRecordExporter();
  initTelemetry({ serviceName: 'otel-log-stream-fixture', logRecordExporter: logExporter });

  const { createLogger } = await import('@rasta/logging');
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const logger = createLogger({
    serviceName: 'otel-log-stream-fixture',
    level: 'debug',
    environment: 'test',
    pretty: false,
    destination,
  });

  logger.error('failed Bearer SYNTHETIC_SECRET');
  logger.info({ note: 'postgres://app:SYNTHETIC_SECRET@db/app' }, 'structured');
  logger.warn({ err: new Error('connect postgres://app:SYNTHETIC_SECRET@db/app') }, 'with error');
  logger.info(`${'x'.repeat(1_048_600)} Bearer SYNTHETIC_SECRET`);
  logger.info('Bearer a '.repeat(2_000));
  // Codex on #290, r5 R5-1: the stack scan's cut lands between this password
  // and its `@` (password at 65,520, `@` at 65,536).
  logger.error(
    { err: new Error(`${'x'.repeat(65_492)}\n    at postgres://u:SYNTHETIC_SECRET@db/app`) },
    'failed',
  );

  // The simple processor hands records to the exporter on a later tick.
  await new Promise((done) => setTimeout(done, 200));
  const records = logExporter.getFinishedLogRecords().map((record) => ({
    severityText: record.severityText,
    body: record.body,
    attributes: record.attributes,
  }));

  // A destination failing after its write returned, as a member of the
  // multistream the instrumentation built: contained, not an uncaught exception.
  const uncaught: string[] = [];
  process.on('uncaughtException', (error) => uncaught.push(String(error)));
  const failing = createLogger({
    serviceName: 'otel-log-stream-fixture',
    environment: 'test',
    pretty: false,
    destination: new Writable({
      write(_chunk, _encoding, done) {
        done(new Error('synthetic late failure'));
      },
    }),
  });
  const streamSym = Object.getOwnPropertySymbols(failing).find(
    (symbol) => symbol.toString() === 'Symbol(pino.stream)',
  );
  const stream = streamSym
    ? (failing as unknown as Record<symbol, { streams?: unknown[] }>)[streamSym]
    : undefined;
  const failingMembers = stream?.streams?.length ?? 0;
  failing.info('one');
  failing.info('two');
  await new Promise((done) => setTimeout(done, 100));

  writeFileSync(outputFile, JSON.stringify({ lines, records, uncaught, failingMembers }));
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
