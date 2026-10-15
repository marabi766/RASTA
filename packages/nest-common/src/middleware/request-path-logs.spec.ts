import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * No client data from a request reaches a trace-correlated OTel log record
 * (S-09, Codex on #261): not its query (`RequestContextMiddleware` records the
 * path alone, r1 F2), not the query of a URL an error names, in its message,
 * its cause or `originalMessage` (`safeLogText`, r2 F2) — whatever the query or
 * fragment holds (an apostrophe, quotes, any script; r3 F1) — and not a correlation
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

interface ExportedSpan {
  name: string;
  scope: string;
  attributes: Record<string, unknown>;
  events: { name: string; attributes?: Record<string, unknown> }[];
  status: { code: number; message?: string };
}

interface FixtureResult {
  statuses: number[];
  correlationIds: (string | null)[];
  logs: ExportedLog[];
  spans: ExportedSpan[];
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

/** The exception forms and URL variants of the fixture's `/v1/url/<form>/<variant>` (r3 F1). */
const ERROR_FORMS = ['plain', 'internal', 'gateway'] as const;
const URL_VARIANTS = ['apostrophe', 'fragment', 'quoted', 'unicode', 'path'] as const;
const URL_PATHS = ERROR_FORMS.flatMap((form) =>
  URL_VARIANTS.map((variant) => `/v1/url/${form}/${variant}`),
);

/** Each variant's URL as redacted: up to its first `?` or `#`, then `[REDACTED]`. */
const REDACTED_URLS: Record<(typeof URL_VARIANTS)[number], string> = {
  apostrophe: 'https://idp.example/cb?[REDACTED]',
  fragment: 'https://idp.example/cb#[REDACTED]',
  quoted: 'https://idp.example/cb?[REDACTED]',
  unicode: 'https://idp.example/cb?[REDACTED]',
  path: '/v1/cb?[REDACTED]',
};

/** The prose error of `/v1/prose`: a question, no URL, logged as it is. */
const PROSE = 'Is the ledger ready? Not yet; retry later?';

/** What each error of `/v1/cut/<kind>` reads once redacted: cut at the cap, its secret gone (r5 F1). */
const CUT_MESSAGES = {
  credentials: 'connect ECONNREFUSED postgresql://[REDACTED]…[TRUNCATED]',
  bearer: 'upstream said: Authorization: Bearer [REDACTED]…[TRUNCATED]',
  password: 'POST https://idp.example/token?[REDACTED]…[TRUNCATED]',
  quoted: `Unexpected token 'p', "[REDACTED]…[TRUNCATED]`,
} as const;
const CUT_PATHS = Object.keys(CUT_MESSAGES).map((kind) => `/v1/cut/${kind}`);

/** The statuses of the fixture's requests, in the order it sends them. */
const STATUSES = [
  403,
  400,
  400,
  500,
  404,
  500,
  500,
  502,
  ...ERROR_FORMS.flatMap((form) => URL_VARIANTS.map(() => (form === 'gateway' ? 502 : 500))),
  500,
  ...CUT_PATHS.map(() => 500),
];

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Runs the fixture with its logger at `level`, plus `env`. */
async function runFixture(
  level: 'debug' | 'info',
  extraEnv: Record<string, string> = {},
): Promise<FixtureResult> {
  const dir = mkdtempSync(join(tmpdir(), 'correlated-logs-'));
  const output = join(dir, 'result.json');
  try {
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('OTEL_')),
      ),
      // Nothing to collect metrics here; their default exporter would dial localhost:4318.
      OTEL_METRICS_EXPORTER: 'none',
      ...extraEnv,
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
        ...URL_PATHS.map((path) => [
          'error',
          'Unhandled error: An unexpected error occurred',
          path,
        ]),
        ['error', 'Unhandled error: An unexpected error occurred', '/v1/prose'],
        ...CUT_PATHS.map((path) => [
          'error',
          'Unhandled error: An unexpected error occurred',
          path,
        ]),
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

  it('a URL whose query or fragment holds an apostrophe, quotes, brackets or any script: redacted from its ? or # on, in each exception form (r3 F1)', () => {
    const expected = ERROR_FORMS.flatMap(() =>
      URL_VARIANTS.map((variant) => {
        const message = `Token exchange failed: POST ${REDACTED_URLS[variant]}`;
        return [`${message}: GET ${REDACTED_URLS[variant]} refused`, { originalMessage: message }];
      }),
    );
    expect(
      URL_PATHS.map((path) => {
        const attributes = byPath(result.logs, path)?.attributes ?? {};
        return [attributes['exception.message'], attributes['internalContext']];
      }),
    ).toEqual(expected);
  });

  it('the same errors on their NestJS handler spans: status and exception redacted alike (r3 F1)', () => {
    const handlers = result.spans.filter(
      (span) =>
        span.scope === '@opentelemetry/instrumentation-nestjs-core' &&
        span.name === 'AssetsController.url',
    );
    expect(
      handlers.map((span) => [
        span.attributes['url.full'],
        span.status.message,
        span.events.map((event) => event.attributes?.['exception.message']),
      ]),
    ).toEqual(
      URL_PATHS.map((path, i) => {
        const message = `Token exchange failed: POST ${REDACTED_URLS[URL_VARIANTS[i % URL_VARIANTS.length]!]}`;
        return [path, message, [message]];
      }),
    );
  });

  it('prose with a question: logged and traced as it is — a ? with whitespace or the end after it is not a query', () => {
    expect(byPath(result.logs, '/v1/prose')?.attributes).toMatchObject({
      'exception.message': PROSE,
      internalContext: { originalMessage: PROSE },
    });
    const [handler] = result.spans.filter((span) => span.name === 'AssetsController.prose');
    expect(handler?.status.message).toBe(PROSE);
  });

  it('a secret an error holds past the cap — a connection string, a bearer token, a password= pair, a quoted body: logged and traced cut, none of it kept, the frames kept (r5 F1, L1)', () => {
    expect(
      CUT_PATHS.map((path) => {
        const attributes = byPath(result.logs, path)?.attributes ?? {};
        return [attributes['exception.message'], attributes['internalContext']];
      }),
    ).toEqual(
      // The message, then its cause's (pino's error serializer).
      Object.values(CUT_MESSAGES).map((message) => [
        `${message}: ${message}`,
        { originalMessage: message },
      ]),
    );
    const handlers = result.spans.filter((span) => span.name === 'AssetsController.cut');
    expect(handlers.map((span) => span.status.message)).toEqual(Object.values(CUT_MESSAGES));
    for (const [i, span] of handlers.entries()) {
      const [exception] = span.events;
      const [header, ...frames] = String(exception?.attributes?.['exception.stacktrace']).split(
        '\n',
      );
      expect(header).toBe(`Error: ${Object.values(CUT_MESSAGES)[i]}`);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every((line) => /^\s+at /.test(line))).toBe(true);
    }
  });
});

describe('under OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT=40 — a cut value carries nothing either (debug logging)', () => {
  let result: FixtureResult;

  beforeAll(async () => {
    result = await runFixture('debug', { OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: '40' });
  }, CHILD_TIMEOUT_MS + 5_000);

  it('no exported log record or span holds "LEAK"', () => {
    const { logs, spans, statuses } = result;
    expect(statuses).toEqual(STATUSES);
    expect(logs).toHaveLength(STATUSES.length);
    expect(spans.length).toBeGreaterThan(0);
    expect(logs.filter((log) => JSON.stringify(log).includes('LEAK'))).toEqual([]);
    expect(spans.filter((span) => JSON.stringify(span).includes('LEAK'))).toEqual([]);
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
      ...STATUSES.filter((status) => status >= 500).map(() => 'error'),
    ]);
    expect(logs.filter((log) => JSON.stringify(log).includes('LEAK'))).toEqual([]);
    expect(spans.filter((span) => JSON.stringify(span).includes('LEAK'))).toEqual([]);
  });
});
