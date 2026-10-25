import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The class guard for display text. The Persian comma «،» was refused in five
 * services and two portal modules at once because each kept its own copy of an
 * Arabic-script allow-list; `displayText` / `DISPLAY_TEXT_PATTERN` in
 * `./text.ts` is now the one definition. This spec fails the day anyone writes
 * another `\p{Script=Arabic}` allow-list outside the two narrower, deliberate
 * ones, or re-declares a local `displayText`.
 */
const ROOT = resolve(__dirname, '../../../..');

/** The deliberately narrower name policies, each with its own tests. */
const NAME_POLICIES = new Set([
  'services/identity-service/src/identity/dto.ts', // person names
  'services/organization-service/src/organization/dto.ts', // organisation names
]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !/\.(spec|test)\./.test(entry)) out.push(path);
  }
  return out;
}

const SOURCE_FILES = [
  ...readdirSync(join(ROOT, 'services')).flatMap((service) => {
    const src = join(ROOT, 'services', service, 'src');
    return statSync(join(ROOT, 'services', service)).isDirectory() && safeIsDir(src)
      ? sources(src)
      : [];
  }),
  ...sources(join(ROOT, 'apps/web/src')),
  ...sources(join(ROOT, 'packages')).filter((path) => !path.includes('/packages/contracts/src/')),
].map((path) => relative(ROOT, path));

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

describe('display-text allow-lists', () => {
  it('scans a meaningful set of files', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(300);
    expect(SOURCE_FILES).toContain('services/fleet-service/src/fleet/dto.ts');
    expect(SOURCE_FILES).toContain('apps/web/src/server/asset-commands.ts');
  });

  it('keeps every \\p{Script=Arabic} allow-list to the two name policies', () => {
    const offenders = SOURCE_FILES.filter(
      (file) => read(file).includes('Script=Arabic') && !NAME_POLICIES.has(file),
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
