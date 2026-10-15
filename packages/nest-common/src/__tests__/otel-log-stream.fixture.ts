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

  // The simple processor hands records to the exporter on a later tick.
  await new Promise((done) => setTimeout(done, 200));
  const records = logExporter.getFinishedLogRecords().map((record) => ({
    severityText: record.severityText,
    body: record.body,
    attributes: record.attributes,
  }));
  writeFileSync(outputFile, JSON.stringify({ lines, records }));
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
