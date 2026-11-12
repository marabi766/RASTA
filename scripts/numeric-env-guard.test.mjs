import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { authoredFiles } from './authored-source-inventory.cjs';
import { fixtureGitEnv } from './fixture-git-env.mjs';
import { analyzeNumericEnv } from './numeric-env-analysis.mjs';
import {
  FROZEN_RATCHET,
  checkNumericEnv,
  ratchetGrowth,
  readRatchet,
  bootstrapRatchet,
} from './numeric-env-guard.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GUARD = 'scripts/numeric-env-guard.mjs';
const TABLE = GUARD;
const sourceFile = (path) =>
  /\.[cm]?[jt]sx?$/.test(path) || /^packages\/[^/]+\/package\.json$/.test(path);
const files = () =>
  new Map(
    authoredFiles(ROOT)
      .map((path) => relative(ROOT, path))
      .filter(sourceFile)
      .map((path) => [path, readFileSync(`${ROOT}${path}`, 'utf8')]),
  );

test('repository import closure obeys the exact per-site ratchet, including web', () => {
  const result = checkNumericEnv(ROOT, files());
  assert.ok(result.roots.includes('apps/web/src/server/env.ts'));
  assert.ok(result.scope.includes('services/api-gateway/src/http/trust-proxy.ts'));
  assert.ok(result.scope.includes('packages/contracts/src/common/zod-issues.ts'));
  assert.ok(result.scope.length >= 162);
  assert.deepEqual(result.errors, []);
  assert.equal(result.sites.length, FROZEN_RATCHET.length);
});

test('fingerprints only shrink against the verified static-guard base, never swap', () => {
  assert.deepEqual(readRatchet(readFileSync(`${ROOT}${GUARD}`, 'utf8')), FROZEN_RATCHET);
  const base = process.env.SERVICE_ENV_WITHHELD_BASE || 'origin/main';
  const git = (...args) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env: fixtureGitEnv() });
  git('rev-parse', '--verify', `${base}^{commit}`);
  const listed = git('ls-tree', '--name-only', base, '--', TABLE).trim();
  let previous;
  const baseSource = listed && git('show', `${base}:${TABLE}`);
  if (baseSource && /JSON\.parse\(`\[/.test(baseSource)) previous = readRatchet(baseSource);
  else {
    const paths = git('ls-tree', '-r', '--name-only', base, '--', 'services', 'apps')
      .split('\n')
      .filter(
        (path) =>
          /^services\/[^/]+\/src\/config\/env\.ts$/.test(path) ||
          path === 'apps/web/src/server/env.ts',
      );
    previous = bootstrapRatchet(
      git('show', `${base}:${GUARD}`),
      new Map(paths.map((path) => [path, git('show', `${base}:${path}`)])),
    );
  }
  assert.deepEqual(ratchetGrowth(FROZEN_RATCHET, previous), []);
});

const BAD = [
  `const {coerce} = z; const schema = coerce.number()`,
  `import {coerce} from 'zod'; const schema = coerce.number()`,
  `import {z as y} from 'zod'; const schema = y.coerce.number()`,
  `import * as zz from 'zod'; const schema = zz.coerce.number()`,
  `import * as zz from 'zod'; const schema = zz.z.coerce.number()`,
  `const c = z.coerce; const schema = c.number()`,
  'const schema = z[`coerce`][`number`]()',
  `const schema = z.number({coerce:true} as never)`,
  `const options = {coerce:true}; const schema = z.number({...options} as never)`,
  `const schema = z.coerce.bigint()`,
  `const schema = z.preprocess(Number, z.number())`,
  `const schema = z.preprocess(v => +v, z.number())`,
  `const schema = z.string().transform(Number).pipe(z.number())`,
  `const schema = z.number().pipe(z.preprocess(Number, z.number()))`,
  `const env = process.env; const n = Number(env.X)`,
  `const {X} = process.env; const n = Number(X)`,
  `const {env: source} = process; const n = Number(source.X)`,
  `const n = globalThis.Number(process.env.X)`,
  `const n = BigInt(process.env.X)`,
  `const n = +process.env.X`,
  `const n = parseFloat(process.env.X)`,
  `const n = Number.parseFloat(process.env.X)`,
  `const n = parseInt(process.env.X, 10)`,
  `const n = Number.parseInt(process.env.X, 10)`,
  `export function load(source: NodeJS.ProcessEnv) { return Number(source.X) }`,
  `const f = Number; const n = f(process.env.X)`,
  `const {parseInt: f} = Number; const n = f(process.env.X)`,
  `const schema = z.string().transform(Number.parseInt)`,
  `const f = Number.bind(null); const schema = z.string().transform(f)`,
  `const schema = z.preprocess(v => v * 1, z.number())`,
  `const schema = z.preprocess(v => Math.floor(v as number), z.number())`,
  `declare const opaque: (v:unknown)=>number; const schema = z.preprocess(v => opaque(v), z.number())`,
  `declare const opaque: (v:unknown)=>unknown; const schema = z.preprocess(opaque, z.number())`,
  `const schema = z.preprocess(v => JSON.parse(v as string), z.number())`,
  `const mystery: any = {}; const schema = mystery.coerce.number()`,
  `function wholeNumberEnv(v: string) { return Number(v) }; const schema = z.preprocess(wholeNumberEnv, z.number())`,
  `const method = 'number'; const schema = z.coerce[method]()`,
  `const c = true ? z : z.coerce; const schema = c.number()`,
  `const n = process.env.X as unknown as number; const value = Number(n)`,
  `function f(v:number) { return Number(v) }; const n = f(process.env.X as unknown as number)`,
  `const schema = z.string().transform(() => 5)`,
  `const schema = z.preprocess(() => 5, z.number())`,
  `const schema = z.codec(z.string(), z.number(), {decode:Number, encode:String})`,
  `const schema = z.string().transform(v => new Uint32Array([v as any])[0])`,

  `const n = (process.env.X as any) * 1`,
  `const n = (process.env.X as any) | 0`,
  `let raw: any = process.env.X; const n = ++raw`,
  `const {X}: {X:number} = process.env as any; const n = Number(X)`,
  `let x: number = 5; x = process.env.X as any; const n = Number(x)`,
  `function parse(v:{n:number}) {return Number(v.n)}; const n = parse({n:process.env.X as any})`,
  `declare const external: z.ZodType<number, string>; const schema = z.object({X:external})`,
  `declare function opaque(): z.ZodType<number, string>; const schema = z.object({X:opaque()})`,
  `const schema = z.object({X:z.string().transform(()=>5)})`,
  `import {wholeNumberEnv} from '@rasta/config'; const schema = z.object({X:wholeNumberEnv(0,10).catch(5)})`,
  `declare const ext: z.ZodObject<{X:z.ZodType<number,string>}>; const schema=z.object({}).merge(ext)`,
  `declare const ext: any; const schema=z.object({X:ext})`,
  `declare const ext: any; const schema=z.object({...ext})`,
  `function format(v:number){return String(v)}; const n=Number(format(process.env.X as unknown as number))`,
  `function format(v:number){return v.toString()}; const n=Number(format(process.env.X as unknown as number))`,
  `function pass(v:number){return v}; const n=Number(pass(process.env.X as unknown as number))`,

  `function pass(v:number){return v ? v : 0}; const n=Number(pass(process.env.X as unknown as number))`,
  `function pass(v:number){return v || 0}; const n=Number(pass(process.env.X as unknown as number))`,
];
const GOOD = [
  `const n = Number('5'); const v = 5; const m = Number(v)`,
  `const schema = z.number().min(1).max(10)`,
  `import {wholeNumberEnv as whole, boundedWholeNumberEnv, wholeBigintEnv, parseWholeNumber} from '@rasta/config';
    const schema = whole(0, 10); const bounded = boundedWholeNumberEnv(0, 10, 5); const big = wholeBigintEnv(0n, 100n);
    const n = parseWholeNumber(process.env.X ?? '', {min:0,max:10})`,
  `const fake = {coerce:{number:()=>5}}; const schema = fake.coerce.number()`,
  `function Number(v: string) { return v }; const text = Number(process.env.X ?? '')`,
  `// z.coerce.number(); Number(process.env.X)
    const text = 'Number(process.env.X)'; const numeric = 42`,
  `const format = (v: number) => String(v); const n = Number(format(42))`,
  `const schema = z.number().transform(v => v * 2)`,
  `function pass(v:number){return v}; const n=Number(pass(42)); const m=Number(Math.floor(42)); const now=Number(Date.now())`,
];
function fixture(snippets) {
  const inputs = new Map([
    ['packages/config/package.json', '{"name":"@rasta/config"}'],
    [
      'packages/config/src/index.ts',
      `export {wholeNumberEnv,boundedWholeNumberEnv,wholeBigintEnv,parseWholeNumber} from './env'`,
    ],
    [
      'packages/config/src/env.ts',
      `import {z} from 'zod';
      export function wholeNumberEnv(min:number,max:number) { return z.string().transform(Number).pipe(z.number().min(min).max(max)) }
      export function boundedWholeNumberEnv(min:number,max:number,fallback:number) { return wholeNumberEnv(min,max).prefault(String(fallback)) }
      export function wholeBigintEnv(min:bigint,max:bigint) { return z.string().transform(BigInt).pipe(z.bigint().min(min).max(max)) }
      export function parseWholeNumber(text:string, bounds:unknown) { return Number(text) }`,
    ],
  ]);
  const roots = snippets.map((source, index) => {
    const path = `services/api-gateway/src/fixture-${index}/env.ts`;
    inputs.set(path, `import {z} from 'zod';\n${source}`);
    return path;
  });
  return { inputs, roots };
}

test('symbol and value provenance refuses every review reproduction and sibling', () => {
  const { inputs, roots } = fixture(BAD);
  const result = analyzeNumericEnv(ROOT, inputs, roots);
  assert.ok(
    !result.errors.some((error) => error.includes('unresolved import')),
    result.errors.join('\n'),
  );
  const missed = BAD.filter(
    (source, index) =>
      !(
        result.errors.some((error) => error.startsWith(`${roots[index]}:`)) ||
        result.sites.some((site) => site.fingerprint[0] === roots[index])
      ),
  );
  assert.deepEqual(missed, []);
});

test('reviewed helpers, numeric values, non-env conversions and shadowed lookalikes pass', () => {
  const { inputs, roots } = fixture(GOOD);
  const result = checkNumericEnv(ROOT, inputs, [], roots);
  assert.deepEqual(result.errors, []);
});

test('imported helpers/re-exports/JS files are in scope and unresolved edges refuse', () => {
  const { inputs, roots } = fixture([
    `import {schema} from './bridge'; export const envSchema = z.object({X:schema})`,
  ]);
  inputs.set('services/api-gateway/src/fixture-0/bridge.ts', `export {schema} from '../parser.js'`);
  inputs.set(
    'services/api-gateway/src/parser.js',
    `import {z} from 'zod'; export const schema=z.string().transform(Number)`,
  );
  const result = checkNumericEnv(ROOT, inputs, [], roots);
  assert.ok(result.scope.includes('services/api-gateway/src/parser.js'));
  assert.ok(
    result.errors.some(
      (error) => error.includes('parser.js:') && error.includes('numeric callback'),
    ),
  );
  inputs.delete('services/api-gateway/src/parser.js');
  assert.ok(
    checkNumericEnv(ROOT, inputs, [], roots).errors.some((error) =>
      error.includes('unresolved import'),
    ),
  );
  inputs.set(roots[0], 'const =');
  assert.throws(() => checkNumericEnv(ROOT, inputs, [], roots), /unreadable/);
});

test('per-site equality detects removals, additions and count-preserving swaps', () => {
  const { inputs, roots } = fixture([`const schema = z.object({OLD:z.coerce.number().min(1)})`]);
  const table = analyzeNumericEnv(ROOT, inputs, roots).sites.map((site) => site.fingerprint);
  assert.equal(table.length, 1);
  assert.deepEqual(checkNumericEnv(ROOT, inputs, table, roots).errors, []);
  inputs.set(
    roots[0],
    `import {z} from 'zod'; const schema=z.object({OLD:z /* comment */ .coerce\n.number().min(1)})`,
  );
  assert.deepEqual(checkNumericEnv(ROOT, inputs, table, roots).errors, []);
  inputs.set(
    roots[0],
    `import {z} from 'zod'; const schema=z.object({NEW:z.coerce.number().min(1)})`,
  );
  assert.equal(checkNumericEnv(ROOT, inputs, table, roots).errors.length, 2);
  const swap = analyzeNumericEnv(ROOT, inputs, roots).sites.map((site) => site.fingerprint);
  assert.equal(ratchetGrowth(swap, table).length, 1);
  inputs.set(roots[0], `const n = 1`);
  assert.equal(checkNumericEnv(ROOT, inputs, table, roots).errors.length, 1);
  assert.deepEqual(checkNumericEnv(ROOT, inputs, [], roots).errors, []);
  assert.deepEqual(ratchetGrowth([], table), []);
  for (const value of ['{}', '[[]]', '[["a","b",1]]', JSON.stringify([...table, ...table])])
    assert.throws(() => readRatchet(value), /invalid/);
});

test('only the exported reviewed helper declarations grant authority', () => {
  const { inputs, roots } = fixture([
    `import {forged} from '@rasta/config'; const n = forged(process.env.X ?? '')`,
  ]);
  inputs.set(
    'packages/config/src/index.ts',
    inputs.get('packages/config/src/index.ts') + `; export {forged} from './env'`,
  );
  inputs.set(
    'packages/config/src/env.ts',
    inputs.get('packages/config/src/env.ts') +
      `
    export function forged(v:string) { function wholeNumberEnv() { return Number(v) }; return wholeNumberEnv() }`,
  );
  const result = checkNumericEnv(ROOT, inputs, [], roots);
  assert.ok(
    result.errors.some(
      (error) =>
        error.startsWith('packages/config/src/env.ts:') && error.includes('unreviewed Number'),
    ),
  );
});
