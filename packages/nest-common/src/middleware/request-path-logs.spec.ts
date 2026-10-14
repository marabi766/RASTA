import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * No client data from a request reaches a trace-correlated OTel log record
 * (S-09, Codex on #261): not its query (`RequestContextMiddleware` records the
 * path alone, r1 F2), not the query of a URL an error names, in its message,
 * its cause or `originalMessage` (`safeLogText`, r2 F2), and not a correlation
 * id that is not one the platform minted (#259's rule, r2 F3). That is what
 * `AllExceptionsFilter` logs and pino's instrumentation forwards, with the
 * span's context, through the Logs API. Checked at the export boundary —
 * in-memory log and span exporters behind the real instrumentations — in
 * `__tests__/correlated-logs.fixture.ts`, once at debug and once at info.
 */

interface ExportedLog {
  severityText?: string;
  body: unknown;
  attributes: Record<string, unknown>;
  correlated: boolean;
}

interface FixtureResult {
  statuses: number[];
  correlationIds: (string | null)[];
  logs: ExportedLog[];
  spans: unknown[];
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

/** The statuses of the fixture's requests, in the order it sends them. */
const STATUSES = [403, 400, 400, 500, 404, 500, 500, 502];

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Runs the fixture with its logger at `level`. */
async function runFixture(level: 'debug' | 'info'): Promise<FixtureResult> {
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
    await promisify(execFile)(process.execPath, ['-e', RUN_FIXTURE, output, level], {
      cwd: PACKAGE_DIR,
      env,
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(readFileSync(output, 'utf8')) as FixtureResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const byPath = (logs: ExportedLog[], path: string): ExportedLog | undefined =>
  logs.find((log) => log.attributes['path'] === path);

describe('trace-correlated log records carry no client data from the request (debug logging)', () => {
  let result: FixtureResult;

  beforeAll(async () => {
    result = await runFixture('debug');
  }, CHILD_TIMEOUT_MS + 5_000);

  it('the requests were refused as the filter refuses them', () => {
    expect(result.statuses).toEqual(STATUSES);
  });

  it('no exported log record or span holds "LEAK"', () => {
    const { logs, spans } = result;
    expect(logs).toHaveLength(STATUSES.length);
    expect(spans.length).toBeGreaterThan(0);
    expect(logs.filter((log) => JSON.stringify(log).includes('LEAK'))).toEqual([]);
    expect(spans.filter((span) => JSON.stringify(span).includes('LEAK'))).toEqual([]);
  });

  it('every request in a context: path alone, stitched to the trace', () => {
    expect(
      result.logs
        .filter((log) => log.attributes['path'] !== undefined)
        .map(({ severityText, body, attributes, correlated }) => ({
          severityText,
          body,
          method: attributes['method'],
          path: attributes['path'],
          correlated,
        })),
    ).toEqual(
      [
        ['warn', 'Access denied: FORBIDDEN', '/v1/assets'],
        ['error', 'Unhandled error: An unexpected error occurred', '/v1/boom'],
        ['debug', 'Request rejected: NOT_FOUND', '/v1/missing'],
        ['error', 'Unhandled error: An unexpected error occurred', '/v1/oauth'],
        ['error', 'Unhandled error: An unexpected error occurred', '/v1/oauth-internal'],
        ['error', 'Unhandled error: An unexpected error occurred', '/v1/oauth-gateway'],
      ].map(([severityText, body, path]) => ({
        severityText,
        body,
        method: 'GET',
        path,
        correlated: true,
      })),
    );
  });

  it('bodies the JSON parser refuses, one line or several: logged before any request context, so with no path', () => {
    const rejected = result.logs.filter(
      (log) => log.body === 'Request rejected: VALIDATION_FAILED',
    );
    expect(rejected).toHaveLength(2);
    for (const log of rejected) {
      expect(log.correlated).toBe(true);
      expect(log.attributes).not.toHaveProperty('path');
      expect(log.attributes['exception.message']).toBe('The request body is not valid JSON');
    }
  });

  it("Nest's own 404 for an unknown route: its text names the path alone", () => {
    expect(byPath(result.logs, '/v1/missing')?.attributes['exception.message']).toBe(
      'Cannot GET /v1/missing',
    );
  });

  it('an error naming an OAuth URL, and its cause: the URLs keep their path, not their query', () => {
    const token = 'Token exchange failed: POST https://idp.example/token?[REDACTED]';
    const withCause = `${token}: GET https://idp.example/cb?[REDACTED] refused`;
    expect(
      ['/v1/oauth', '/v1/oauth-internal', '/v1/oauth-gateway'].map((path) => {
        const attributes = byPath(result.logs, path)?.attributes ?? {};
        return [attributes['exception.message'], attributes['internalContext']];
      }),
    ).toEqual([
      [withCause, { originalMessage: token }],
      [withCause, { originalMessage: token }],
      [token, { originalMessage: token }],
    ]);
  });
});

describe('a correlation id that is a token is never adopted (#259 rule; info logging)', () => {
  let result: FixtureResult;

  beforeAll(async () => {
    result = await runFixture('info');
  }, CHILD_TIMEOUT_MS + 5_000);

  it('the 403 is logged at warn, under a fresh id — the one its response carries', () => {
    expect(result.statuses).toEqual(STATUSES);
    const [refusal] = result.logs.filter((log) => log.severityText === 'warn');
    expect(refusal?.body).toBe('Access denied: FORBIDDEN');
    expect(refusal?.correlated).toBe(true);
    expect(refusal?.attributes['correlationId']).toMatch(ULID);
    expect(refusal?.attributes['correlationId']).toBe(result.correlationIds[0]);
  });

  it('no exported log record or span holds "LEAK"', () => {
    const { logs, spans } = result;
    // At info, the debug refusals (400, 404) are not logged.
    expect(logs.map((log) => log.severityText)).toEqual([
      'warn',
      'error',
      'error',
      'error',
      'error',
    ]);
    expect(logs.filter((log) => JSON.stringify(log).includes('LEAK'))).toEqual([]);
    expect(spans.filter((span) => JSON.stringify(span).includes('LEAK'))).toEqual([]);
  });
});
