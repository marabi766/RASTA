/**
 * @jest-environment node
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { PSQL_FAILED, draftContract, signedContract } from '../../e2e/contract-fixture';

/**
 * The live contract scenarios' fixture never repeats its database URL (#385 r6,
 * Codex PR-385 r5 F1). It used `new URL`, whose TypeError keeps the whole URL
 * on `.input`; and a psql that failed after a good parse threw the child's
 * error, whose message and `stderr` carry psql's text — the user it connected
 * as, among it. Both entry points, both refusals, with the two sentinels of
 * scripts/refusal-probes.mjs as the URL's username and password.
 */

const USER = 'private-sentinel-79';
const PASSWORD = 'JZ97-another-secret';
const SENTINEL = /sentinel|jz97|another[-_]secret/i;
/** Built from its parts: a literal credentialed URL is a secret scanner's finding. */
const credentialed = (port: string): string =>
  ['postgresql://', USER, ':', PASSWORD, '@127.0.0.1:', port, '/rasta_contract'].join('');

const PARTIES = { employer: 'ORG-A', contractor: 'ORG-B', amountMinor: '100' };
const ENTRY_POINTS = [
  ['draftContract', draftContract],
  ['signedContract', signedContract],
] as const;

function everythingOf(value: unknown): string {
  if (!(value instanceof Error)) return inspect(value, { depth: 10 });
  return [
    value.message,
    value.stack ?? '',
    JSON.stringify(value, Object.getOwnPropertyNames(value)),
    inspect(value, { depth: 10, showHidden: true }),
    value.cause === undefined ? '' : inspect(value.cause, { depth: 10, showHidden: true }),
  ].join('\n');
}

function thrownBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

describe('e2e/contract-fixture refusals', () => {
  const saved = { url: process.env.WEB_E2E_CONTRACT_DATABASE_URL, path: process.env.PATH };
  let bin: string;

  beforeAll(() => {
    // A psql that fails as a refused login does: its stderr names the user.
    bin = mkdtempSync(join(tmpdir(), 'contract-fixture-psql-'));
    writeFileSync(
      join(bin, 'psql'),
      '#!/bin/sh\necho "psql: error: password authentication failed for user \\"$PGUSER\\" ($PGPASSWORD)" >&2\nexit 2\n',
    );
    chmodSync(join(bin, 'psql'), 0o755);
  });

  afterAll(() => {
    rmSync(bin, { recursive: true, force: true });
    process.env.PATH = saved.path;
    if (saved.url === undefined) delete process.env.WEB_E2E_CONTRACT_DATABASE_URL;
    else process.env.WEB_E2E_CONTRACT_DATABASE_URL = saved.url;
  });

  it('the control: new URL itself keeps both sentinels for this URL', () => {
    expect(everythingOf(thrownBy(() => new URL(credentialed('bad'))))).toMatch(SENTINEL);
  });

  it.each(ENTRY_POINTS)('%s refuses an unreadable URL by name only', (_, write) => {
    process.env.WEB_E2E_CONTRACT_DATABASE_URL = credentialed('bad');
    const error = thrownBy(() => write(PARTIES));
    expect((error as Error).message).toBe(
      'WEB_E2E_CONTRACT_DATABASE_URL cannot be read as a URL; its value is not repeated',
    );
    expect(everythingOf(error)).not.toMatch(SENTINEL);
  });

  it.each(ENTRY_POINTS)(
    '%s reports a failed psql by its exit code only, nothing of its stderr',
    (_, write) => {
      process.env.WEB_E2E_CONTRACT_DATABASE_URL = credentialed('5432');
      process.env.PATH = `${bin}:${saved.path}`;
      const error = thrownBy(() => write(PARTIES));
      expect((error as Error).message).toBe(PSQL_FAILED(2));
      expect(everythingOf(error)).not.toMatch(SENTINEL);
      expect(everythingOf(error)).not.toMatch(/authentication/);
    },
  );
});
