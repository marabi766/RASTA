import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import type * as zodModule from 'zod';

/**
 * Codex PR-444 r2 F1, closed at one boundary: zod 3 kept parsing after a
 * failed check, so a refusal listed the number's later checks **and** every
 * enclosing refinement (`?limit=0.5&cursor=bad` read four issues); zod 4
 * stopped at the integer and read two. The fix is not per schema: the
 * repository's patch of zod (`patches/zod@<version>.patch`, applied by pnpm)
 * restores zod 3's run order in the one zod every workspace resolves, for
 * every schema there is and every one written later. This guard keeps it
 * that way: the catalog's zod is the patched one, the lockfile resolves no
 * other, and the copy each workspace loads parses as zod 3 did.
 */

const ROOT = join(__dirname, '../../../..');
const workspaceYaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
const lockfile = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
const VERSION = /^catalog:\s*\n\s+zod:\s*(\S+)/m.exec(workspaceYaml)?.[1];
const PATCH = `patches/zod@${VERSION}.patch`;
/** One marker per restored rule and build (ESM `.js`, CommonJS `.cjs`). */
const MARKER = '@rasta patch (PR #444)';
const RULES = 5;

/** The workspaces that depend on zod, by their package.json. */
const WORKSPACES = ['apps', 'services', 'packages']
  .flatMap((parent) => readdirSync(join(ROOT, parent)).map((name) => join(ROOT, parent, name)))
  .filter((dir) => {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return 'zod' in { ...manifest.dependencies, ...manifest.devDependencies };
    } catch {
      return false;
    }
  });

type Zod = typeof zodModule;
type Outcome = string[] | 'accepted';

/** The codes of a refusal, in order. */
function codes(schema: { safeParse(input: unknown): unknown }, input: unknown): Outcome {
  const result = schema.safeParse(input) as { error?: { issues: { code: string }[] } };
  return result.error ? result.error.issues.map((issue) => issue.code) : 'accepted';
}

/** zod 3's run order, one case per patched rule: what zod 3 reported, in its order. */
function zod3RunOrder({ z }: Zod): [string, Outcome, Outcome][] {
  const refused = <T extends zodModule.ZodType>(schema: T) =>
    schema.refine(() => false, { message: 'enclosing', path: ['refinement'] });
  return [
    [
      'a failed .int() goes on to the later checks and the enclosing refinement',
      codes(refused(z.object({ n: z.number().int().min(1) })), { n: 0.5 }),
      ['invalid_type', 'too_small', 'custom'],
    ],
    [
      '±Infinity is refused as a number, and the parse goes on',
      codes(refused(z.object({ n: z.number().max(5) })), { n: Number.POSITIVE_INFINITY }),
      ['invalid_type', 'too_big', 'custom'],
    ],
    [
      'an issue a transform adds does not stop the enclosing refinement',
      codes(
        refused(
          z.object({
            b: z.string().transform((value, ctx) => {
              ctx.addIssue({ code: 'custom', message: 'not a boolean' });
              return value;
            }),
          }),
        ),
        { b: 'x' },
      ),
      ['custom', 'custom'],
    ],
    [
      'a value refused before its transform stops the enclosing refinement',
      codes(
        refused(
          z.object({
            s: z
              .string()
              .min(3)
              .transform((value) => value),
          }),
        ),
        { s: 'x' },
      ),
      ['too_small'],
    ],
    [
      'a union answers with its first option that failed only on checks, and goes on',
      codes(refused(z.object({ u: z.union([z.string().min(5), z.string().regex(/^a+$/)]) })), {
        u: 'b',
      }),
      ['too_small', 'custom'],
    ],
  ];
}

describe('zod is patched to zod 3’s run order (Codex PR-444 r2 F1)', () => {
  it('the catalog’s zod is the patched version, with every rule in both builds', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(workspaceYaml).toMatch(
      new RegExp(`^patchedDependencies:\\s*\\n\\s+zod@${VERSION}: ${PATCH}\\s*$`, 'm'),
    );
    const patch = readFileSync(join(ROOT, PATCH), 'utf8');
    const added = patch.split('\n').filter((line) => line.startsWith('+') && line.includes(MARKER));
    expect(added).toHaveLength(RULES * 2);
  });

  it('the lockfile resolves zod only as the patched copy', () => {
    const hash = new RegExp(`^patchedDependencies:\\s*\\n\\s+zod@${VERSION}: (\\w+)`, 'm').exec(
      lockfile,
    )?.[1];
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const resolved = [...lockfile.matchAll(/\bzod@(\d+\.\d+\.\d+)(\(patch_hash=(\w+)\))?/g)];
    const unpatched = resolved.filter(
      ([, version, , patched], at) =>
        version !== VERSION || (patched !== hash && !isPackageEntry(lockfile, resolved[at])),
    );
    expect(unpatched.map(([text]) => text)).toEqual([]);
    const section = /\nimporters:\n([\s\S]*?)\n\S/.exec(lockfile)?.[1] ?? '';
    const importers = [...section.matchAll(/^\s+zod:\s*\n\s+specifier: .*\n\s+version: (.*)$/gm)];
    expect(importers.length).toBeGreaterThanOrEqual(WORKSPACES.length);
    expect(importers.filter(([, version]) => version !== `${VERSION}(patch_hash=${hash})`)).toEqual(
      [],
    );
  });

  it.each(WORKSPACES.map((dir) => [relative(ROOT, dir), dir]))(
    '%s loads the patched copy, and it parses as zod 3 did',
    (_name, dir) => {
      const load = createRequire(join(dir, 'package.json'));
      const entry = load.resolve('zod');
      expect(entry).toContain(`zod@${VERSION}_patch_hash=`);
      for (const [rule, observed, zod3] of zod3RunOrder(load('zod') as Zod)) {
        expect([rule, observed]).toEqual([rule, zod3]);
      }
      // The ESM build (Next's bundles) carries the same rules as the CommonJS one.
      const core = join(dirname(entry), 'v4/core');
      const markers = (ext: string) =>
        ['checks', 'schemas', 'api']
          .map((file) => join(core, `${file}.${ext}`))
          .concat(join(dirname(entry), `v4/classic/schemas.${ext}`))
          .filter((file) => statSync(file, { throwIfNoEntry: false }))
          .map((file) => readFileSync(file, 'utf8').split(MARKER).length - 1)
          .reduce((sum, count) => sum + count, 0);
      expect([markers('js'), markers('cjs')]).toEqual([RULES, RULES]);
    },
  );

  it('uses no zod 4 method whose zod 3 namesake meant something else', () => {
    // zod 4's `.safe()` is a second `.int()`; zod 3's was the ±(2^53 − 1) bounds.
    const offenders = productionSources().filter(({ text }) => /\.safe\(\)/.test(text));
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });
});

/** The package's own entry (`zod@4.6.7:` / `zod@4.6.7(patch_hash=…):`), not a resolution. */
function isPackageEntry(text: string, match: RegExpMatchArray): boolean {
  const start = text.lastIndexOf('\n', match.index ?? 0) + 1;
  return /^ {2}zod@\d+\.\d+\.\d+:/.test(text.slice(start, start + 40));
}

function productionSources(): { file: string; text: string }[] {
  const walk = (dir: string): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    return entries.flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        return ['node_modules', 'dist', '.next', 'test', '__fixtures__', 'generated'].includes(
          entry,
        )
          ? []
          : walk(path);
      }
      return /\.(ts|tsx)$/.test(entry) && !/\.(spec|test|int-spec)\.|fixture/.test(entry)
        ? [path]
        : [];
    });
  };
  return WORKSPACES.flatMap((dir) => walk(join(dir, 'src'))).map((path) => ({
    file: relative(ROOT, path),
    text: readFileSync(path, 'utf8'),
  }));
}
