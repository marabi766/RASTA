import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DiagLogLevel, diag } from '@opentelemetry/api';
import {
  OTEL_SETTINGS,
  SafeDiagLogger,
  UNKNOWN_LOG_LEVEL,
  describeDiagnostic,
  installSafeDiagnostics,
  requestedLogLevel,
  withoutSdkLogLevel,
} from './diagnostics';
import { UNREADABLE_OTLP_ENDPOINT } from './telemetry';

/**
 * The OpenTelemetry SDK's diagnostics never print an `OTEL_*` value (#385 r5,
 * Codex PR-385 r4 F1). The SDK reads every inherited `OTEL_*` variable — even
 * with `OTEL_SDK_DISABLED` — and, with `OTEL_LOG_LEVEL` set, its constructor
 * installs a console logger that quotes what it could not use. Each case runs
 * the real `initTelemetry` in a child process under an environment where every
 * setting the SDK reports on carries the two sentinels, at every
 * `OTEL_LOG_LEVEL` and with the SDK enabled, disabled and malformedly disabled,
 * and reads the child's whole stdout and stderr.
 */

const FIXTURE = resolve(__dirname, '__tests__/diagnostics.fixture.ts');
const SWC_OPTIONS = resolve(__dirname, '../../../jest.swc.cjs');
const CHILD_TIMEOUT_MS = 90_000;
const CONCURRENCY = 4;

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

/** The two sentinels of `scripts/refusal-probes.mjs`: a username and a password. */
const USER = 'private-sentinel-79';
const PASSWORD = 'JZ97-another-secret';
/** Any piece of either, in any spelling. */
const SENTINEL = /sentinel|jz97|another[-_]secret/i;
/** A URL with both as credentials, and a port that is not one. */
const CREDENTIAL_URL = `http://${USER}:${PASSWORD}@127.0.0.1:bad`;

/**
 * Every setting the SDK reports on, wrong in a way that carries a sentinel:
 * the general and signal-specific endpoints, compression, timeouts, protocols
 * and headers; the exporter, propagator, detector and instrumentation lists;
 * numeric and boolean readers; sampler and resource attributes.
 */
const SENTINEL_ENV: Readonly<Record<string, string>> = Object.freeze({
  OTEL_EXPORTER_OTLP_ENDPOINT: CREDENTIAL_URL,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: CREDENTIAL_URL,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: CREDENTIAL_URL,
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: CREDENTIAL_URL,
  OTEL_EXPORTER_OTLP_COMPRESSION: USER,
  OTEL_EXPORTER_OTLP_TRACES_COMPRESSION: PASSWORD,
  OTEL_EXPORTER_OTLP_METRICS_COMPRESSION: USER,
  OTEL_EXPORTER_OTLP_LOGS_COMPRESSION: PASSWORD,
  OTEL_EXPORTER_OTLP_TIMEOUT: PASSWORD,
  OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: USER,
  OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: PASSWORD,
  OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: USER,
  OTEL_EXPORTER_OTLP_PROTOCOL: USER,
  OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: PASSWORD,
  OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: USER,
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: PASSWORD,
  OTEL_EXPORTER_OTLP_HEADERS: USER,
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: PASSWORD,
  OTEL_EXPORTER_OTLP_INSECURE: USER,
  OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: PASSWORD,
  OTEL_EXPORTER_OTLP_METRICS_DEFAULT_HISTOGRAM_AGGREGATION: USER,
  OTEL_TRACES_EXPORTER: `otlp,${USER}`,
  OTEL_METRICS_EXPORTER: `otlp,${PASSWORD}`,
  OTEL_LOGS_EXPORTER: `otlp,${USER}`,
  OTEL_PROPAGATORS: `tracecontext,${PASSWORD}`,
  OTEL_NODE_RESOURCE_DETECTORS: `env,${USER}`,
  OTEL_NODE_DISABLED_INSTRUMENTATIONS: PASSWORD,
  OTEL_METRIC_EXPORT_INTERVAL: PASSWORD,
  OTEL_METRIC_EXPORT_TIMEOUT: USER,
  OTEL_METRICS_EXEMPLAR_FILTER: PASSWORD,
  OTEL_BSP_SCHEDULE_DELAY: USER,
  OTEL_BSP_MAX_QUEUE_SIZE: PASSWORD,
  OTEL_BLRP_SCHEDULE_DELAY: USER,
  OTEL_ATTRIBUTE_COUNT_LIMIT: PASSWORD,
  OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT: USER,
  OTEL_NODE_EXPERIMENTAL_SDK_METRICS: PASSWORD,
  OTEL_TRACES_SAMPLER: USER,
  OTEL_TRACES_SAMPLER_ARG: PASSWORD,
  OTEL_RESOURCE_ATTRIBUTES: USER,
});

/** Settings whose diagnostic the safe logger must still name: the proof each was reached. */
const NAMED_AT_WARN = [
  'OTEL_EXPORTER_OTLP_METRICS_COMPRESSION',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_NODE_RESOURCE_DETECTORS',
];

const LOG_LEVELS = [
  undefined,
  'NONE',
  'ERROR',
  'WARN',
  'INFO',
  'DEBUG',
  'VERBOSE',
  'ALL',
  'warn',
  PASSWORD,
] as const;
/** OTEL_SDK_DISABLED: unset (enabled), disabled, and malformed. */
const DISABLED = [undefined, 'true', USER] as const;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The fixture's last stdout line. */
  outcome: Record<string, unknown>;
}

/** The environment without anything inherited from OTEL_*, plus `extra`. */
function childEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('OTEL_')),
  );
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  return env;
}

function runFixture(mode: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<Run> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      ['-e', RUN_FIXTURE, mode, ...args],
      { env, timeout: CHILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const last = stdout.trim().split('\n').pop() ?? '';
        let outcome: Record<string, unknown> = {};
        try {
          outcome = JSON.parse(last) as Record<string, unknown>;
        } catch {
          outcome = {};
        }
        const code = error ? ((error as { code?: number }).code ?? null) : 0;
        done({ code: typeof code === 'number' ? code : null, stdout, stderr, outcome });
      },
    );
  });
}

async function inPool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  return results;
}

const label = (level: string | undefined, disabled: string | undefined): string =>
  `OTEL_LOG_LEVEL=${level === PASSWORD ? '<sentinel>' : (level ?? 'unset')}, ` +
  `OTEL_SDK_DISABLED=${disabled === USER ? '<malformed>' : (disabled ?? 'unset')}`;

describe('the OpenTelemetry SDK diagnostics under initTelemetry (child processes)', () => {
  const runs = new Map<string, Run>();
  let baseline: Run;
  let explicit: Run;
  const exports = new Map<string, Run>();

  beforeAll(async () => {
    const tasks: (() => Promise<void>)[] = [];
    for (const level of LOG_LEVELS) {
      for (const disabled of DISABLED) {
        tasks.push(async () => {
          const env = childEnv({
            ...SENTINEL_ENV,
            OTEL_LOG_LEVEL: level,
            OTEL_SDK_DISABLED: disabled,
          });
          runs.set(label(level, disabled), await runFixture('current', env));
        });
      }
    }
    tasks.push(async () => {
      baseline = await runFixture(
        'baseline',
        childEnv({ ...SENTINEL_ENV, OTEL_LOG_LEVEL: 'WARN', OTEL_SDK_DISABLED: 'true' }),
      );
    });
    tasks.push(async () => {
      explicit = await runFixture(
        'explicit',
        childEnv({ OTEL_LOG_LEVEL: 'ALL', OTEL_TRACES_EXPORTER: 'none' }),
        CREDENTIAL_URL,
      );
    });
    for (const level of [undefined, 'WARN', 'ALL']) {
      tasks.push(async () => {
        exports.set(
          level ?? 'unset',
          await runFixture(
            'exports',
            childEnv({
              OTEL_LOG_LEVEL: level,
              OTEL_METRICS_EXPORTER: 'none',
              OTEL_LOGS_EXPORTER: 'none',
            }),
          ),
        );
      });
    }
    await inPool(tasks, CONCURRENCY);
  }, 600_000);

  it('the control: a bare NodeSDK under the same environment quotes both sentinels', () => {
    // So the cases below are not vacuous: this environment really makes the
    // SDK print its values, here even with the SDK disabled.
    const output = `${baseline.stdout}${baseline.stderr}`;
    expect(output).toContain(USER);
    expect(output).toContain(PASSWORD);
  });

  describe.each(
    LOG_LEVELS.flatMap((level) =>
      DISABLED.map((disabled) => [label(level, disabled), level, disabled] as const),
    ),
  )('%s', (name, level, disabled) => {
    it('runs to the end, shutdown included, and prints no piece of either sentinel', () => {
      const run = runs.get(name)!;
      expect({ code: run.code, crashed: run.outcome.crashed }).toEqual({
        code: 0,
        crashed: undefined,
      });
      expect(['ok', 'failed']).toContain(run.outcome.shutdown);
      expect(run.stdout).not.toMatch(SENTINEL);
      expect(run.stderr).not.toMatch(SENTINEL);
    });

    it('still reports, by setting name, what the SDK could not use — at the level asked for', () => {
      const run = runs.get(name)!;
      const requested = requestedLogLevel(level);
      const warns =
        requested === 'unknown' || (requested !== null && requested >= DiagLogLevel.WARN);
      for (const setting of NAMED_AT_WARN) {
        const line = new RegExp(`\\[telemetry\\] WARN configuration \\([^)]*${setting}`);
        if (warns) expect(run.stderr).toMatch(line);
        else expect(run.stderr).not.toMatch(line);
      }
      if (warns && disabled === USER) {
        // The malformed OTEL_SDK_DISABLED is diagnosed before the SDK sets
        // up anything; it went through the safe logger too.
        expect(run.stderr).toMatch(/\[telemetry\] WARN configuration \([^)]*OTEL_SDK_DISABLED/);
      }
      const unknownNotices = run.stderr.split(UNKNOWN_LOG_LEVEL).length - 1;
      expect(unknownNotices).toBe(requested === 'unknown' ? 1 : 0);
      // Every line on stderr is the safe logger's.
      for (const line of run.stderr.split('\n').filter(Boolean)) {
        expect(line).toMatch(/^\[telemetry\] (ERROR|WARN|INFO|DEBUG|VERBOSE) /);
      }
    });
  });

  it('an explicit OTLP endpoint that is not a URL is refused with a fixed text', () => {
    expect(explicit.code).toBe(0);
    expect(explicit.outcome.thrown).toEqual(expect.stringContaining(UNREADABLE_OTLP_ENDPOINT));
    expect(explicit.stdout).not.toMatch(SENTINEL);
    expect(explicit.stderr).not.toMatch(SENTINEL);
  });

  it.each(['unset', 'WARN', 'ALL'])(
    'the positive control: with OTEL_LOG_LEVEL=%s telemetry still exports (and shuts down)',
    (level) => {
      const run = exports.get(level)!;
      expect({ code: run.code, exported: run.outcome.exported }).toEqual({ code: 0, exported: 2 });
    },
  );
});

describe('the safe logger', () => {
  afterEach(() => diag.disable());

  it('reads OTEL_LOG_LEVEL as the SDK does: upper-cased, untrimmed, own keys only', () => {
    expect(requestedLogLevel(undefined)).toBeNull();
    expect(requestedLogLevel('  ')).toBeNull();
    expect(requestedLogLevel('warn')).toBe(DiagLogLevel.WARN);
    expect(requestedLogLevel('ALL')).toBe(DiagLogLevel.ALL);
    expect(requestedLogLevel('NONE')).toBe(DiagLogLevel.NONE);
    expect(requestedLogLevel(' warn')).toBe('unknown');
    expect(requestedLogLevel('constructor')).toBe('unknown');
    expect(requestedLogLevel(PASSWORD)).toBe('unknown');
  });

  it('prints the level, an audited category and registered names only', () => {
    expect(
      describeDiagnostic('WARN', [
        `Configuration: OTEL_EXPORTER_OTLP_COMPRESSION is invalid (actual: '${USER}')`,
      ]),
    ).toBe(
      '[telemetry] WARN configuration (OTEL_EXPORTER_OTLP_COMPRESSION): ' +
        "the OpenTelemetry SDK's own text is withheld; it may repeat configuration values",
    );
    // A name that is not registered is not printed, whatever it spells.
    expect(
      describeDiagnostic('WARN', [`bad OTEL_${PASSWORD.toUpperCase().replaceAll('-', '_')}`]),
    ).not.toMatch(SENTINEL);
    // Arguments are tested, never printed: an error, an object, a URL.
    const line = describeDiagnostic('ERROR', [
      '@opentelemetry/instrumentation-http',
      new Error(CREDENTIAL_URL),
      { url: CREDENTIAL_URL },
    ]);
    expect(line).toMatch(/^\[telemetry\] ERROR instrumentation: /);
    expect(line).not.toMatch(SENTINEL);
  });

  it('is the global diag logger after install, at the level asked for', () => {
    const lines: string[] = [];
    installSafeDiagnostics({ OTEL_LOG_LEVEL: 'WARN' }, (text) => lines.push(text));
    diag.info(`not at WARN: ${USER}`);
    diag.warn(`Unknown value '${PASSWORD}' for OTEL_METRIC_EXPORT_INTERVAL`);
    diag.error(new Error(CREDENTIAL_URL) as unknown as string);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toMatch(SENTINEL);
    expect(lines[0]).toContain('(OTEL_METRIC_EXPORT_INTERVAL)');
  });

  it('prints nothing with OTEL_LOG_LEVEL unset, as the SDK did', () => {
    const lines: string[] = [];
    installSafeDiagnostics({}, (text) => lines.push(text));
    diag.error('anything');
    expect(lines).toEqual([]);
  });

  it('reports an unknown level once, by name, and uses INFO; re-installing is silent', () => {
    const lines: string[] = [];
    const reinstall = installSafeDiagnostics({ OTEL_LOG_LEVEL: PASSWORD }, (text) =>
      lines.push(text),
    );
    reinstall();
    reinstall();
    diag.info('an info line');
    diag.debug('not at INFO');
    expect(lines).toEqual([
      `[telemetry] WARN configuration: ${UNKNOWN_LOG_LEVEL}`,
      expect.stringMatching(/^\[telemetry\] INFO sdk: /),
    ]);
  });

  it('a logger the SDK installs over it is replaced by re-installing', () => {
    const lines: string[] = [];
    const reinstall = installSafeDiagnostics({ OTEL_LOG_LEVEL: 'ALL' }, (text) => lines.push(text));
    const raw: string[] = [];
    diag.setLogger(
      {
        error: (m) => raw.push(m),
        warn: (m) => raw.push(m),
        info: (m) => raw.push(m),
        debug: (m) => raw.push(m),
        verbose: (m) => raw.push(m),
      },
      { logLevel: DiagLogLevel.ALL, suppressOverrideMessage: true },
    );
    // setLogger itself reports the registration to the logger it installs.
    raw.length = 0;
    reinstall();
    diag.warn(USER);
    expect(raw).toEqual([]);
    // At ALL, the API's own registration notices (DEBUG) come through too.
    expect(lines.filter((line) => line.startsWith('[telemetry] WARN '))).toHaveLength(1);
  });

  it('SafeDiagLogger writes one line per call whatever it is given', () => {
    const lines: string[] = [];
    const logger = new SafeDiagLogger((text) => lines.push(text));
    logger.verbose(USER, PASSWORD);
    logger.debug(CREDENTIAL_URL);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toMatch(SENTINEL);
  });

  it('withoutSdkLogLevel hides OTEL_LOG_LEVEL while it runs and restores it exactly', () => {
    const before = process.env.OTEL_LOG_LEVEL;
    try {
      process.env.OTEL_LOG_LEVEL = 'WARN';
      expect(withoutSdkLogLevel(() => process.env.OTEL_LOG_LEVEL)).toBeUndefined();
      expect(process.env.OTEL_LOG_LEVEL).toBe('WARN');
      expect(() =>
        withoutSdkLogLevel(() => {
          throw new Error('constructor failed');
        }),
      ).toThrow('constructor failed');
      expect(process.env.OTEL_LOG_LEVEL).toBe('WARN');
      delete process.env.OTEL_LOG_LEVEL;
      withoutSdkLogLevel(() => undefined);
      expect(Object.hasOwn(process.env, 'OTEL_LOG_LEVEL')).toBe(false);
    } finally {
      if (before === undefined) delete process.env.OTEL_LOG_LEVEL;
      else process.env.OTEL_LOG_LEVEL = before;
    }
  });
});

describe('OTEL_SETTINGS', () => {
  /** The `@opentelemetry/*` packages the SDK and the auto-instrumentations load. */
  function installedPackages(): string[] {
    // Each one's directory of siblings: `<store>/node_modules/@opentelemetry`.
    // Resolved from its entry point — auto-instrumentations' `exports` map
    // does not export its package.json.
    const roots = ['@opentelemetry/sdk-node', '@opentelemetry/auto-instrumentations-node'].map(
      (name) => {
        const entry = realpathSync(require.resolve(name));
        const at = entry.lastIndexOf('/node_modules/@opentelemetry/');
        return entry.slice(0, at + '/node_modules/@opentelemetry'.length);
      },
    );

    const found = new Set<string>();
    for (const root of roots) {
      for (const name of readdirSync(root)) found.add(realpathSync(join(root, name)));
    }
    return [...found];
  }

  function jsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return jsFiles(path);
      return path.endsWith('.js') ? [path] : [];
    });
  }

  it('names every OTEL_* setting the installed SDK packages read', () => {
    const read = new Set<string>();
    for (const pkg of installedPackages()) {
      let files: string[];
      try {
        files = jsFiles(join(pkg, 'build', 'src'));
      } catch {
        continue;
      }
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/['"`](OTEL_[A-Z0-9_]+)['"`]/g)) read.add(match[1]);
      }
    }
    expect(read.size).toBeGreaterThan(50);
    expect([...read].filter((name) => !OTEL_SETTINGS.has(name)).sort()).toEqual([]);
  });
});
