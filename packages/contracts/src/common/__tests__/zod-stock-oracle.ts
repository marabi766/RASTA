import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

/**
 * An unmodified zod, loaded on its own, for the acceptance differential
 * (D-078, PR #444 r4 addendum A): what stock zod 4 decides is what every parse
 * must decide, and the oracle cannot be the patched copy it judges.
 *
 * The stock package is rebuilt from the installed (patched) one by reversing
 * the repository's patch into a fresh directory, then proved byte-for-byte the
 * published package: its tree hash must equal the one recorded from the npm
 * tarball whose sha512 is the lockfile's integrity for this version. No
 * network, no second install; a version bump, a stale patch or any drift in a
 * single file fails here instead of judging against the wrong zod.
 */

export const ROOT = join(__dirname, '../../../../..');
const CONTRACTS = join(ROOT, 'packages/contracts');

/** The version the oracle stands for, and the lockfile integrity of its tarball. */
export const STOCK_ZOD_VERSION = '4.6.7';
export const STOCK_ZOD_INTEGRITY =
  'sha512-g8W2D2kU6a8untc053fX1uVBKzM7yqAxW/3zwk83+6RyF2+SKOuV+c0wBDhUwzV1PaGapmZH+rmcUzPf+3CGwg==';
/**
 * Tree hash ({@link treeHash}) of the files of `npm pack zod@4.6.7`, whose
 * sha512 is {@link STOCK_ZOD_INTEGRITY}: 840 files.
 */
export const STOCK_ZOD_TREE = {
  files: 840,
  sha256: '2448693342bd42ca59a12b7589106bd432189efc92e6b7e8195be96b9c28a113',
};

/** The directory of the zod every workspace loads (the patched copy). */
export function patchedZodDir(): string {
  return dirname(require.resolve('zod/package.json', { paths: [CONTRACTS] }));
}

/** sha256 over `path NUL sha256(bytes) LF` of every file, sorted by path. */
export function treeHash(dir: string): { files: number; sha256: string } {
  const files: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(dir, path).split(sep).join('/'));
    }
  };
  walk(dir);
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const bytes = readFileSync(join(dir, file));
    hash.update(`${file}\0${createHash('sha256').update(bytes).digest('hex')}\n`);
  }
  return { files: files.length, sha256: hash.digest('hex') };
}

/** Undoes a unified diff (pnpm's patch format) in `dir`: each hunk's new text back to its old. */
export function reversePatch(dir: string, patch: string): void {
  for (const section of patch.split(/^diff --git /m).slice(1)) {
    const file = /^\+\+\+ b\/(.+)$/m.exec(section)?.[1];
    if (!file) throw new Error('patch section without a target file');
    const path = join(dir, file);
    let text = readFileSync(path, 'utf8');
    for (const hunk of section.split(/^@@ [^\n]*@@[^\n]*\n/m).slice(1)) {
      const lines = hunk.split('\n');
      if (lines.at(-1) === '') lines.pop();
      const before: string[] = [];
      const after: string[] = [];
      for (const line of lines) {
        if (line.startsWith('\\')) continue;
        const body = line.slice(1);
        if (line.startsWith('-')) before.push(body);
        else if (line.startsWith('+')) after.push(body);
        else {
          before.push(body);
          after.push(body);
        }
      }
      const patched = `${after.join('\n')}\n`;
      const at = text.indexOf(patched);
      if (at < 0 || text.indexOf(patched, at + 1) >= 0) {
        throw new Error(`patch hunk is not found exactly once in ${file}`);
      }
      text = text.slice(0, at) + `${before.join('\n')}\n` + text.slice(at + patched.length);
    }
    writeFileSync(path, text);
  }
}

export interface StockZod {
  dir: string;
  /** CommonJS entry. */
  cjs: string;
  /** ESM entry (loaded through `require(esm)` in the build child, Node ≥ 22.12). */
  esm: string;
}

let stock: StockZod | undefined;

/** Stock zod, materialised once per process in a fresh temporary directory and verified. */
export function materializeStockZod(): StockZod {
  if (stock) return stock;
  const lockfile = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  const entry = new RegExp(
    `^ {2}zod@${STOCK_ZOD_VERSION.replace(/\./g, '\\.')}:\\n {4}resolution: \\{integrity: (\\S+)\\}`,
    'm',
  ).exec(lockfile)?.[1];
  if (entry !== STOCK_ZOD_INTEGRITY) {
    throw new Error(
      `the lockfile's zod@${STOCK_ZOD_VERSION} is not the tarball the oracle was recorded from`,
    );
  }
  const parent = mkdtempSync(join(tmpdir(), 'rasta-zod-stock-'));
  const dir = join(parent, 'zod');
  try {
    cpSync(patchedZodDir(), dir, { recursive: true, dereference: true });
    reversePatch(dir, readFileSync(join(ROOT, `patches/zod@${STOCK_ZOD_VERSION}.patch`), 'utf8'));
    const tree = treeHash(dir);
    if (tree.files !== STOCK_ZOD_TREE.files || tree.sha256 !== STOCK_ZOD_TREE.sha256) {
      throw new Error('the stock zod rebuilt from the installed copy is not the published package');
    }
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
  stock = { dir, cjs: join(dir, 'index.cjs'), esm: join(dir, 'index.js') };
  return stock;
}

/** Removes the materialised copy (a spec's `afterAll`). */
export function releaseStockZod(): void {
  if (!stock) return;
  rmSync(dirname(stock.dir), { recursive: true, force: true });
  stock = undefined;
}

export type Build = 'cjs' | 'esm';

const RUNNER = join(__dirname, 'zod-differential.ts');
const ZOD_ISSUES = join(__dirname, '../zod-issues.ts');

/**
 * Runs `task` of `zod-differential.ts` in a fresh Node process, in one of
 * zod's two builds: `zod` (for `legacyParse` too) resolves to the patched
 * package's CommonJS or ESM entry, and the stock oracle is the same build of
 * {@link materializeStockZod}. Outside Jest's module system, so the ESM build
 * is the real one Next bundles.
 */
export function runInBuild<T>(build: Build, task: string, args: unknown = {}): T {
  const oracle = materializeStockZod();
  const patched = join(patchedZodDir(), build === 'cjs' ? 'index.cjs' : 'index.js');
  const swc = require.resolve('@swc/core', { paths: [CONTRACTS] });
  // Everything on stdin: the child reads no command line (scripts/cli-contract.mjs).
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', CHILD], {
    input: JSON.stringify({
      swc,
      patched,
      stock: build === 'cjs' ? oracle.cjs : oracle.esm,
      runner: RUNNER,
      zodIssues: ZOD_ISSUES,
      task,
      args,
    }),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 300_000,
  });
  return JSON.parse(out) as T;
}

const CHILD = `
const fs = require('node:fs');
const Module = require('node:module');
const { swc: swcPath, patched: patchedEntry, stock: stockEntry, runner, zodIssues, task, args } =
  JSON.parse(fs.readFileSync(0, 'utf8'));
const swc = require(swcPath);
require.extensions['.ts'] = (mod, file) =>
  mod._compile(
    swc.transformSync(fs.readFileSync(file, 'utf8'), {
      filename: file,
      jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
      module: { type: 'commonjs' },
    }).code,
    file,
  );
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'zod' ? patchedEntry : resolve.call(this, request, ...rest);
};
const patched = require(patchedEntry);
const stock = require(stockEntry);
if (patched.z === stock.z || patched.z.ZodType === stock.z.ZodType) throw new Error('the oracle is the patched zod');
const issues = require(zodIssues);
Promise.resolve(require(runner)[task]({ patched: patched.z, stock: stock.z, issues }, args))
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch((error) => { console.error(error); process.exit(1); });
`;
