import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

/**
 * `zod/no-default` through both real configurations (PR #444 r1 F2): the root
 * one, as a service file is linted, and the portal's, as a web file is. Each
 * escape the review found — and the ones next to it — is refused in both.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'apps/web');
const TREES = [
  { name: 'root', cwd: ROOT, file: 'services/asset-service/src/probe.ts' },
  { name: 'web', cwd: WEB, file: 'src/server/probe.ts' },
];

/**
 * Lints `codes` as `file` under `cwd`'s config, in a process of its own:
 * typescript-eslint refuses a second config root in one process.
 */
function ruleHitsIn(tree, file, codes) {
  const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--lint'], {
    cwd: tree.cwd,
    input: JSON.stringify({ cwd: tree.cwd, file: join(tree.cwd, file), codes }),
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

if (process.argv[2] === '--lint') {
  const { cwd, file, codes } = JSON.parse(readFileSync(0, 'utf8'));
  const eslint = new ESLint({ cwd });
  const hits = [];
  for (const code of codes) {
    const [result] = await eslint.lintText(code, { filePath: file });
    const fatal = result.messages.find((message) => message.fatal);
    if (fatal) throw new Error(fatal.message);
    hits.push(result.messages.filter((message) => message.ruleId === 'zod/no-default').length);
  }
  process.stdout.write(JSON.stringify(hits));
  process.exit(0);
}

const SCHEMA = "import { z } from 'zod';\nconst s = z.string();\n";

const REFUSED = [
  ['a dot call', "s.default('x');"],
  ['an optional dot call', "s?.default('x');"],
  ['a bracket string', "s['default']('x');"],
  ['a bracket template', 's[`default`](`x`);'],
  ['a template with a static part', "s[`def${'ault'}`]('x');"],
  ['a concatenation', "s['def' + 'ault']('x');"],
  ['a const holding the name', "const name = 'default';\ns[name]('x');"],
  [
    'a const holding a concatenated name',
    "const half = 'ault';\nconst name = 'def' + half;\ns[name]('x');",
  ],
  ['an extracted method', "const d = s.default;\nd('x');"],
  ['an extracted method by bracket', "const d = s['default'];\nd('x');"],
  ['a destructured method', "const { default: d } = s;\nd('x');"],
  ['a destructured computed key', "const { ['default']: d } = s;\nd('x');"],
  ['a destructuring parameter', "const take = ({ default: d }: typeof s) => d('x');\ntake(s);"],
  ['.call', "s.default.call(s, 'x');"],
  ['.apply', "s.default.apply(s, ['x']);"],
  ['.bind', "s.default.bind(s)('x');"],
  ['.call by bracket', "s['default'].call(s, 'x');"],
  ['Reflect.get', "Reflect.get(s, 'default');"],
  ['Object.getOwnPropertyDescriptor', "Object.getOwnPropertyDescriptor(s, 'default');"],
];

const ALLOWED = [
  ['prefault', "s.prefault('x');"],
  ['a module default export by require', "const page = require('./page').default;\nvoid page;"],
  [
    'a cast module default export',
    "const page = (require('./page') as { default: unknown }).default;\nvoid page;",
  ],
  [
    'a destructured module default export',
    "const { default: Redis } = require('ioredis');\nvoid Redis;",
  ],
  [
    'an awaited dynamic import',
    "export async function f() {\n  return (await import('./page')).default;\n}",
  ],
  ['jest.requireActual', "const real = jest.requireActual('./page').default;\nvoid real;"],
  ['a JSON Schema keyword written', 'const json: Record<string, unknown> = {};\njson.default = 1;'],
  ['a JSON Schema keyword asserted', 'const json = { default: 1 };\nexpect(json.default).toBe(1);'],
  ['an object literal key', 'const json = { default: 1 };\nvoid json;'],
  ['an unrelated name', "s.describe('x');"],
];

for (const tree of TREES) {
  const codes = [...REFUSED, ...ALLOWED].map(([, code]) => SCHEMA + code);
  const hits = ruleHitsIn(tree, tree.file, codes);
  REFUSED.forEach(([label], at) => {
    test(`${tree.name}: refuses ${label}`, () => {
      assert.ok(hits[at] > 0, `${label} passed the ${tree.name} config`);
    });
  });
  ALLOWED.forEach(([label], at) => {
    test(`${tree.name}: allows ${label}`, () => {
      assert.equal(hits[REFUSED.length + at], 0);
    });
  });
  test(`${tree.name}: an env.ts file is still covered (its override turns off z.coerce only)`, () => {
    const env = tree.name === 'root' ? 'packages/config/src/env.ts' : 'src/server/env.ts';
    assert.ok(ruleHitsIn(tree, env, [SCHEMA + "s['default']('x');"])[0] > 0);
  });
}
