/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Server Action body ceiling (`WEB_UPLOAD_MAX_BYTES`, ADR-069 / Q-98): one
 * helper both `next.config.mjs` and this spec load, so what is tested is what
 * the build reads.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const limit = require('../upload-limit.cjs') as {
  uploadMaxBytes: (raw: string | undefined) => number;
  DEFAULT_UPLOAD_MAX_BYTES: number;
  MIN_UPLOAD_MAX_BYTES: number;
  MAX_UPLOAD_MAX_BYTES: number;
};

const MIB = 1024 * 1024;

describe('uploadMaxBytes', () => {
  it('is 26 MiB when nothing is set — just above document-service’s own 25 MiB default', () => {
    expect(limit.DEFAULT_UPLOAD_MAX_BYTES).toBe(26 * MIB);
    expect(limit.uploadMaxBytes(undefined)).toBe(26 * MIB);
    expect(limit.uploadMaxBytes('')).toBe(26 * MIB);
    expect(limit.uploadMaxBytes('   ')).toBe(26 * MIB);
  });

  it('takes a whole number of bytes, between the two bounds, inclusive', () => {
    expect(limit.uploadMaxBytes('52428800')).toBe(50 * MIB);
    expect(limit.uploadMaxBytes(` ${limit.MIN_UPLOAD_MAX_BYTES} `)).toBe(MIB);
    expect(limit.uploadMaxBytes(String(limit.MAX_UPLOAD_MAX_BYTES))).toBe(200 * MIB);
  });

  it.each([
    ['a size with a unit', '26mb'],
    ['a decimal', '26.5'],
    ['a negative', '-1'],
    ['a hexadecimal', '0x1000000'],
    ['text', 'big'],
    ['below the default Next already has', String(MIB - 1)],
    ['zero', '0'],
    ['past document-service’s upper bound', String(200 * MIB + 1)],
    ['past a safe integer', '9'.repeat(30)],
  ])('stops the build for %s, naming the variable', (_what, raw) => {
    expect(() => limit.uploadMaxBytes(raw)).toThrow(/WEB_UPLOAD_MAX_BYTES/);
  });

  it('is what the portal’s build reads', () => {
    const config = readFileSync(join(__dirname, '..', 'next.config.mjs'), 'utf8');
    expect(config).toContain('uploadMaxBytes(process.env.WEB_UPLOAD_MAX_BYTES)');
    expect(config).not.toMatch(/bodySizeLimit:\s*'/);
  });

  it('keeps its upper bound equal to document-service’s own', () => {
    // The two numbers answer one question — how large may an object be — and a
    // portal that admitted more than the service could ever register would
    // accept bytes only to have them refused.
    const env = readFileSync(
      join(__dirname, '..', '..', '..', 'services', 'document-service', 'src', 'config', 'env.ts'),
      'utf8',
    );
    const max =
      /DOCUMENT_MAX_BYTES:\s*z\.coerce[\s\S]*?\.max\(\s*(\d+)\s*\*\s*1024\s*\*\s*1024\s*\)/.exec(
        env,
      );
    expect(max?.[1]).toBe('200');
    expect(limit.MAX_UPLOAD_MAX_BYTES).toBe(200 * MIB);
  });
});
