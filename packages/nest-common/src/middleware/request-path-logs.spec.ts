import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * The request's query never reaches a trace-correlated OTel log record
 * (S-09, Codex on #261, F2): `RequestContextMiddleware` records the path
 * alone, and that `path` is what `AllExceptionsFilter` logs and pino's
 * instrumentation forwards, with the span's context, through the Logs API.
 * Checked at the export boundary — in-memory log and span exporters behind
 * the real instrumentations — in `__tests__/correlated-logs.fixture.ts`.
 */

interface ExportedLog {
  severityText?: string;
  body: unknown;
  attributes: Record<string, unknown>;
  correlated: boolean;
}

const PACKAGE_DIR = resolve(__dirname, '../..');
const FIXTURE = resolve(__dirname, '../__tests__/correlated-logs.fixture.ts');
const SWC_OPTIONS = resolve(PACKAGE_DIR, '../../jest.swc.cjs');
const CHILD_TIMEOUT_MS = 60_000;

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

describe('trace-correlated log records carry the request path, never its query', () => {
  let statuses: number[];
  let logs: ExportedLog[];
  let spans: unknown[];

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'correlated-logs-'));
    const output = join(dir, 'result.json');
    try {
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('OTEL_')),
        ),
        // Nothing to collect metrics here; their default exporter would dial localhost:4318.
        OTEL_METRICS_EXPORTER: 'none',
      };
      await promisify(execFile)(process.execPath, ['-e', RUN_FIXTURE, output], {
        cwd: PACKAGE_DIR,
        env,
        timeout: CHILD_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      ({ statuses, logs, spans } = JSON.parse(readFileSync(output, 'utf8')) as {
        statuses: number[];
        logs: ExportedLog[];
        spans: unknown[];
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, CHILD_TIMEOUT_MS + 5_000);

  it('the requests were refused as the filter refuses them', () => {
    expect(statuses).toEqual([403, 400, 500]);
  });

  it('no exported log record or span holds "LEAK"', () => {
    expect(logs.length).toBeGreaterThan(0);
    expect(spans.length).toBeGreaterThan(0);
    expect(logs.filter((log) => JSON.stringify(log).includes('LEAK'))).toEqual([]);
    expect(spans.filter((span) => JSON.stringify(span).includes('LEAK'))).toEqual([]);
  });

  it('a refusal (warn) and an unhandled error (error): path alone, stitched to the trace', () => {
    expect(
      logs
        .filter((log) => log.attributes['path'] !== undefined)
        .map(({ severityText, body, attributes, correlated }) => ({
          severityText,
          body,
          method: attributes['method'],
          path: attributes['path'],
          correlated,
        })),
    ).toEqual([
      {
        severityText: 'warn',
        body: 'Access denied: FORBIDDEN',
        method: 'GET',
        path: '/v1/assets',
        correlated: true,
      },
      {
        severityText: 'error',
        body: 'Unhandled error: An unexpected error occurred',
        method: 'GET',
        path: '/v1/boom',
        correlated: true,
      },
    ]);
  });

  it('a body the JSON parser refuses: logged before any request context, so with no path', () => {
    const [rejected] = logs.filter((log) => log.body === 'Request rejected: VALIDATION_FAILED');
    expect(rejected?.correlated).toBe(true);
    expect(rejected?.attributes).not.toHaveProperty('path');
  });
});
