import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import type * as zodModule from 'zod';

import {
  materializeStockZod,
  releaseStockZod,
  STOCK_ZOD_TREE,
  treeHash,
} from './__tests__/zod-stock-oracle';

/**
 * Codex PR-444 r2 F1 and r3 F3, D-078. zod 3 kept parsing after a failed
 * check, so a refusal listed the number's later checks **and** every
 * enclosing refinement (`?limit=0.5&cursor=bad` read four issues); zod 4
 * stopped at the integer and read two. The repository's patch of zod
 * (`patches/zod@<version>.patch`, applied by pnpm) restores zod 3's run order
 * in the one zod every workspace resolves — but only behind a per-parse switch
 * that is off by default (r3 F3: run in zod 3's order, an intersection could
 * reconcile away the issue that stopped a refinement, and accept what stock
 * zod refuses). Every ordinary parse is stock zod 4; `legacyParse` alone sets
 * the switch, for the wording of a refusal stock zod already made. This guard
 * keeps it that way: the catalog's zod is the patched one, the lockfile
 * resolves no other, the copy each workspace loads parses as stock zod
 * unless switched and in zod 3's order when switched, and nothing else names
 * the switch.
 */

const ROOT = join(__dirname, '../../../..');
const workspaceYaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
const lockfile = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
const VERSION = /^catalog:\s*\n\s+zod:\s*(\S+)/m.exec(workspaceYaml)?.[1];
const PATCH = `patches/zod@${VERSION}.patch`;
/** One marker per restored rule, plus the switch's declaration in each patched module, per build (ESM `.js`, CommonJS `.cjs`). */
const MARKER = '@rasta patch (PR #444, D-078)';
const RULES = 5;
const MODULES = 2;
const PER_BUILD = RULES + MODULES;
/** zod's switch for zod 3's run order. */
const SWITCH = '@rasta/zod.legacyRunOrder';
const SWITCHED = { [Symbol.for(SWITCH)]: true };

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
function codes(
  schema: { safeParse(input: unknown, params?: unknown): unknown },
  input: unknown,
  params?: object,
): Outcome {
  const result = schema.safeParse(input, params) as { error?: { issues: { code: string }[] } };
  return result.error ? result.error.issues.map((issue) => issue.code) : 'accepted';
}

/**
 * One case per patched rule: `[rule, outcome, what zod 3 reported]`, parsed
 * with `params` — the switch on (zod 3's order) or off (stock zod's).
 */
function zod3RunOrder({ z }: Zod, params?: object): [string, Outcome, Outcome][] {
  const refused = <T extends zodModule.ZodType>(schema: T) =>
    schema.refine(() => false, { message: 'enclosing', path: ['refinement'] });
  return [
    [
      'a failed .int() goes on to the later checks and the enclosing refinement',
      codes(refused(z.object({ n: z.number().int().min(1) })), { n: 0.5 }, params),
      ['invalid_type', 'too_small', 'custom'],
    ],
    [
      '±Infinity is refused as a number, and the parse goes on',
      codes(refused(z.object({ n: z.number().max(5) })), { n: Number.POSITIVE_INFINITY }, params),
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
        params,
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
        params,
      ),
      ['too_small'],
    ],
    [
      'a union answers with its first option that failed only on checks, and goes on',
      codes(
        refused(z.object({ u: z.union([z.string().min(5), z.string().regex(/^a+$/)]) })),
        { u: 'b' },
        params,
      ),
      ['too_small', 'custom'],
    ],
  ];
}

afterAll(releaseStockZod);

describe('zod is patched to zod 3’s run order, off by default (Codex PR-444 r2 F1, r3 F3, D-078)', () => {
  it('the catalog’s zod is the patched version, with every rule in both builds', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(workspaceYaml).toMatch(
      new RegExp(`^patchedDependencies:\\s*\\n\\s+zod@${VERSION}: ${PATCH}\\s*$`, 'm'),
    );
    const patch = readFileSync(join(ROOT, PATCH), 'utf8');
    const added = patch.split('\n').filter((line) => line.startsWith('+') && line.includes(MARKER));
    expect(added).toHaveLength(PER_BUILD * 2);
  });

  it('gates every hunk of the patch on the switch: none is active by default', () => {
    // Each restored rule reads `ctx?.[LEGACY_RUN_ORDER] === true` (or `_ctx?.…`)
    // before it changes anything; the declarations are the registered symbol.
    const added = readFileSync(join(ROOT, PATCH), 'utf8')
      .split('\n')
      .filter(
        (line) => line.startsWith('+') && !/^\+\s*\/\//.test(line) && !line.startsWith('+++'),
      );
    const declarations = added.filter((line) => line.includes('const LEGACY_RUN_ORDER'));
    expect(declarations).toEqual(
      Array.from(
        { length: MODULES * 2 },
        () => `+const LEGACY_RUN_ORDER = Symbol.for("${SWITCH}");`,
      ),
    );
    const gates = added.filter((line) => /_?ctx\?\.\[LEGACY_RUN_ORDER\] === true/.test(line));
    expect(gates).toHaveLength(RULES * 2);
    // No other way to turn it on: no `!==`, no default, no global.
    expect(added.filter((line) => /LEGACY_RUN_ORDER/.test(line)).length).toBe(
      declarations.length + gates.length,
    );
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

  it('judges against the published package: the oracle is stock zod, byte for byte', () => {
    const stock = materializeStockZod();
    expect(treeHash(stock.dir)).toEqual(STOCK_ZOD_TREE);
    expect(stock.dir).not.toContain('node_modules');
  });

  it.each(WORKSPACES.map((dir) => [relative(ROOT, dir), dir]))(
    '%s loads the patched copy: stock zod unless switched, zod 3’s order when switched',
    (_name, dir) => {
      const load = createRequire(join(dir, 'package.json'));
      const entry = load.resolve('zod');
      expect(entry).toContain(`zod@${VERSION}_patch_hash=`);
      const patched = load('zod') as Zod;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const stock = require(materializeStockZod().cjs) as Zod;
      expect(stock.z.ZodType).not.toBe(patched.z.ZodType);
      const off = zod3RunOrder(patched);
      const reference = zod3RunOrder(stock);
      for (const [at, [rule, observed]] of off.entries()) {
        expect([rule, observed]).toEqual([rule, reference[at][1]]);
      }
      for (const [rule, observed, zod3] of zod3RunOrder(patched, SWITCHED)) {
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
      expect([markers('js'), markers('cjs')]).toEqual([PER_BUILD, PER_BUILD]);
    },
  );

  it('names the switch only in legacyParse, the patch and tests', () => {
    // Anyone else who set it would parse in zod 3's order and could accept what
    // stock zod refuses (r3 F3); `legacyParse` sets it only after stock zod
    // refused. Every source of the repository, scripts and tooling included.
    const allowed = new Set([PATCH, 'packages/contracts/src/common/zod-issues.ts']);
    const offenders = repositoryFiles()
      .filter((file) => !allowed.has(file))
      .filter((file) => !/\.(spec|test|int-spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//.test(file))
      .filter((file) => readFileSync(join(ROOT, file), 'utf8').includes(SWITCH));
    expect(offenders).toEqual([]);
  });

  it('uses no zod 4 method whose zod 3 namesake meant something else', () => {
    // zod 4's `.safe()` is a second `.int()`; zod 3's was the ±(2^53 − 1) bounds.
    const offenders = productionSources().filter(({ text }) => /\.safe\(\)/.test(text));
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });
});

/** Every text file of the repository outside dependencies, builds and git. */
function repositoryFiles(): string[] {
  const SKIP = new Set([
    'node_modules',
    'dist',
    '.next',
    '.git',
    '.turbo',
    'coverage',
    'generated',
  ]);
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (SKIP.has(entry.name)) return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.isFile() && /\.(?:[cm]?[jt]sx?|json|ya?ml|patch|sh|md)$/.test(entry.name)
        ? [relative(ROOT, path)]
        : [];
    });
  return walk(ROOT);
}

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
