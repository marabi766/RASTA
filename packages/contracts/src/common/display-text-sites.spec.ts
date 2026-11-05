import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The class guard for display text. The Persian comma «،» was refused in five
 * services and two portal modules at once because each kept its own copy of an
 * Arabic-script allow-list; `displayText` / `DISPLAY_TEXT_PATTERN` in
 * `./text.ts` is now the one definition. This spec fails the day anyone writes
 * another `\p{Script=Arabic}` policy outside the explicit name/orthography
 * policies, or re-declares a local `displayText`.
 */
const ROOT = resolve(__dirname, '../../../..');

/** Deliberately narrower policies, each with its own tests. */
const SCRIPT_POLICIES = new Set([
  'services/identity-service/src/identity/dto.ts', // person names
  'services/organization-service/src/organization/dto.ts', // organisation names
  // Test tooling refuses Arabic-script points outside the explicit Persian repertoire.
  'apps/web/src/test/orthography.ts',
]);

/**
 * The sites are the TRACKED source files, from `git ls-files`, not a walk of the
 * working tree. A walk also visits git-ignored build output (the generated
 * Prisma clients under `src/generated/`), which another test in the same CI job
 * regenerates: a file listed by `readdirSync` and gone by `statSync` failed this
 * suite to run (ENOENT, FU-090). Generated output is not a display-text site.
 * A tracked file that is missing from disk is NOT skipped: `read` throws on it
 * and the presence test below names it. If `git` cannot answer, the suite fails.
 */
const OUTPUT_SEGMENTS = new Set(['node_modules', 'dist', '.next']);

function isSourceSite(file: string): boolean {
  const segments = file.split('/');
  const name = segments[segments.length - 1] ?? '';
  const inScope =
    /^services\/[^/]+\/src\//.test(file) ||
    file.startsWith('apps/web/src/') ||
    (file.startsWith('packages/') && !file.includes('packages/contracts/src/'));
  return (
    inScope &&
    !segments.some((segment) => OUTPUT_SEGMENTS.has(segment)) &&
    /\.(ts|tsx|mjs|js)$/.test(name) &&
    !/\.(spec|test)\./.test(name)
  );
}

function trackedSources(): string[] {
  const listing = execFileSync(
    'git',
    ['ls-files', '-z', '--', 'services', 'apps/web/src', 'packages'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return listing.split('\0').filter((file) => file !== '' && isSourceSite(file));
}

const SOURCE_FILES = trackedSources();

const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

describe('display-text allow-lists', () => {
  it('scans a meaningful set of files', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(300);
    expect(SOURCE_FILES).toContain('services/fleet-service/src/fleet/dto.ts');
    expect(SOURCE_FILES).toContain('apps/web/src/server/asset-commands.ts');
  });

  it('finds every tracked site on disk and none from generated output', () => {
    expect(SOURCE_FILES.filter((file) => !existsSync(join(ROOT, file)))).toEqual([]);
    expect(SOURCE_FILES.filter((file) => file.split('/').includes('generated'))).toEqual([]);
  });

  it('keeps the site filter to source, not output, tests or the contracts package', () => {
    for (const site of [
      'services/a-service/src/x/dto.ts',
      'apps/web/src/a.tsx',
      'packages/config/src/a.mjs',
    ])
      expect(isSourceSite(site)).toBe(true);
    for (const other of [
      'services/a-service/src/x/dto.spec.ts',
      'services/a-service/test/x.ts',
      'services/a-service/src/dist/x.ts',
      'packages/contracts/src/common/text.ts',
      'apps/web/e2e/a.ts',
      'services/a-service/src/x/README.md',
    ])
      expect(isSourceSite(other)).toBe(false);
  });

  it('keeps every \\p{Script=Arabic} policy to the explicit name/orthography policies', () => {
    const offenders = SOURCE_FILES.filter(
      (file) => read(file).includes('Script=Arabic') && !SCRIPT_POLICIES.has(file),
    );
    expect(offenders).toEqual([]);
  });

  it('declares no second displayText in a service or package', () => {
    // The portal's `displayText(label, min, max)` form helper wraps the shared
    // pattern with Persian messages; it is not a service rule.
    const offenders = SOURCE_FILES.filter(
      (file) => !file.startsWith('apps/') && /(?:const|function)\s+displayText\b/.test(read(file)),
    );
    expect(offenders).toEqual([]);
  });

  it.each([
    'services/asset-service/src/asset/dto.ts',
    'services/fleet-service/src/fleet/dto.ts',
    'services/maintenance-service/src/maintenance/dto.ts',
  ])('%s takes displayText from @rasta/contracts', (file) => {
    const text = read(file);
    expect(text).toMatch(/import\s*\{[^}]*\bdisplayText\b[^}]*\}\s*from\s*'@rasta\/contracts'/);
  });

  it('the portal modules import the pattern instead of copying it', () => {
    for (const file of [
      'apps/web/src/server/asset-commands.ts',
      'apps/web/src/server/maintenance-commands.ts',
    ]) {
      expect(read(file)).toMatch(/DISPLAY_TEXT_PATTERN\s*(,|\})[^;]*from '@rasta\/contracts'/s);
    }
  });
});
