import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * With the real `initTelemetry()`, pino's instrumentation adds a second stream
 * to every logger — the one that feeds the OTel Logs API. `createLogger` puts
 * its scrub in front of the whole multistream, so no exporter receives a
 * credential or an over-long record that the configured destination does not
 * (Codex on #290, r4 F1). Checked at the export boundary in
 * `__tests__/otel-log-stream.fixture.ts`.
 */

interface FixtureResult {
  lines: string[];
  records: { severityText?: string; body: unknown; attributes: Record<string, unknown> }[];
  uncaught: string[];
  failingMembers: number;
}

const PACKAGE_DIR = resolve(__dirname, '../..');
const FIXTURE = resolve(__dirname, '../__tests__/otel-log-stream.fixture.ts');
const SWC_OPTIONS = resolve(PACKAGE_DIR, '../../jest.swc.cjs');

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

async function runFixture(): Promise<FixtureResult> {
  const dir = mkdtempSync(join(tmpdir(), 'otel-log-stream-'));
  const output = join(dir, 'result.json');
  try {
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('OTEL_')),
      ),
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_TRACES_EXPORTER: 'none',
    };
    await promisify(execFile)(process.execPath, ['-e', RUN_FIXTURE, output], {
      cwd: PACKAGE_DIR,
      env,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(readFileSync(output, 'utf8')) as FixtureResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the OTel log stream sits behind the scrub (real initTelemetry)', () => {
  let result: FixtureResult;

  beforeAll(async () => {
    result = await runFixture();
  }, 90_000);

  it('the instrumentation is really sending: every call reached the exporter', () => {
    expect(result.records).toHaveLength(6);
    expect(result.lines).toHaveLength(6);
  });

  it('no credential reaches the destination or any exporter', () => {
    expect(JSON.stringify(result.lines)).not.toContain('SYNTHETIC_SECRET');
    expect(JSON.stringify(result.records)).not.toContain('SYNTHETIC_SECRET');
  });

  it('a stack cut before a password\'s "@" exports no part of it (Codex on #290, r5 R5-1)', () => {
    const line = JSON.parse(result.lines[5]!) as { err: { stack: string } };
    const exported = result.records[5]!.attributes['exception.stacktrace'];

    expect(line.err.stack).toContain('…[TRUNCATED]');
    expect(typeof exported).toBe('string');
    expect(exported).toContain('…[TRUNCATED]');
    expect(`${line.err.stack}${String(exported)}`).not.toContain('SYNTHETIC');
  });

  it("a destination failing late inside the instrumentation's multistream is contained (r5 R5-2)", () => {
    expect(result.failingMembers).toBe(2);
    expect(result.uncaught).toEqual([]);
  });

  it('an oversize record is replaced for the exporter as for the destination', () => {
    expect(JSON.stringify(result.records)).not.toContain('xxxxxxxxxx');
    expect(JSON.stringify(result.records)).toContain('line too long');
  });

  it('what the exporter holds is what the destination wrote', () => {
    const bodies = result.lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
    expect(result.records.map((record) => record.body)).toEqual(bodies);
  });
});
