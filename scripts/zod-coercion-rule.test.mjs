import { RuleTester } from 'eslint';
import { describe, it } from 'node:test';

RuleTester.describe = describe;
RuleTester.it = it;
import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';
import rule, { REVIEWED_FILES } from './zod-coercion-rule.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const filename = `${ROOT}packages/contracts/src/probe.ts`;
const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const z = "import { z } from 'zod'; ";
const bad = (code, messageId = 'boundary') => ({ filename, code, errors: [{ messageId }] });

tester.run('zod/coercion-boundary', rule, {
  valid: [
    `${z}export const schema = z.number();`,
    `${z}function shape(key, schema) { return z.object({ [key]: schema }); }`,
    `${z}function f() { return z.NEVER; }`,
    `${z}z.core._url(z.ZodURL, {}); z.core._isoDateTime(z.ZodISODateTime, {});`,
    `${z}expect(fn).toThrow(z.core.$ZodAsyncError); input instanceof z.ZodNumber;`,
    `import { ZodError } from 'zod'; input instanceof ZodError;`,
    `${z}const schema = z.object({n: z.number()}); const { n, ...rest } = schema.parse({n: 1});`,
    `${z}const schema = z.object({}); schema.safeParse({}, { [Symbol.for('key')]: true });`,
    `${z}const schema = z.object({ n: z.number() }); export { schema };`,
    `${z}const alias = z; alias.number();`,
    `${z}function f(z) { return z.coerce.number(); }`,
    `${z}{ const z = { coerce: 1 }; z.coerce; }`,
    `const coerce = (x) => x; coerce(1);`,
    `const other = { coerce: true }; other.coerce;`,
    `import { z } from 'not-zod'; z.coerce.number();`,
    `function f(require) { return require('zod').coerce.number(); }`,
    `import { numberInput } from '@rasta/contracts'; ${z}numberInput(z.number());`,
    `import { digitsToBigInt } from '@rasta/contracts'; ${z}z.string().refine(v => digitsToBigInt(v) !== undefined);`,
    `${z}z.preprocess(v => typeof v === 'string' ? v.trim() : v, z.string());`,
    `${z}z.preprocess(v => v, z.string());`,
    `${z}z.number({ coerce: false });`,
    `${z}const options = { coerce: false }; const alias = options; z.number(alias);`,
    `${z}const message = 'Expected a number'; show(message); z.number(message);`,
    `export type { ZodType } from 'zod';`,
    `import type { z } from 'zod'; export type Schema = z.ZodType;`,
    ...Object.keys(REVIEWED_FILES).map((file) => ({
      filename: `${ROOT}${file}`,
      code: `${z}z.coerce.number();`,
    })),
    {
      filename: `${ROOT}packages/contracts/src/common/number-input.ts`,
      code: `${z}z.preprocess(v => typeof v === 'string' ? Number(v) : v, z.number());`,
    },
  ].map((entry) => (typeof entry === 'string' ? { code: entry, filename } : entry)),
  invalid: [
    bad(`${z}z.coerce.number();`),
    bad(`import schema = require('zod'); schema.coerce.number();`, 'escape'),
    bad(`${z}const N = z.number().constructor; new N({ coerce: true });`),
    bad(`${z}const N = z.number().constructor; new N(getOptions());`),
    bad(`${z}helper(z);`, 'escape'),
    bad(`${z}z.literal(z);`, 'escape'),
    bad(`import schema from 'zod'; schema(schema);`, 'escape'),
    bad(`${z}helper(z.number);`, 'escape'),
    bad(`helper(require('zod'));`, 'escape'),
    bad(`export const helper = { schema: require('zod') };`, 'escape'),
    bad(`helper(await import('zod'));`, 'escape'),
    bad(`${z}export const helper = { schema: z };`, 'escape'),
    bad(`${z}export const helper = [z];`, 'escape'),
    bad(`${z}const alias = flag ? z : other;`, 'escape'),
    bad(`${z}const options = { [getKey()]: true }; z.number(options);`),
    bad(`${z}z.number.call(null, {});`, 'boundary'),
    bad(`${z}z.preprocess.bind(null);`),
    bad(`import { z as schema } from 'zod'; schema.coerce.number();`),
    bad(`import * as schema from 'zod'; schema.z.coerce.number();`),
    bad(`import schema from 'zod'; schema.coerce.number();`),
    bad(`import { coerce as c } from 'zod'; c.number();`),
    bad(`import { z } from 'zod/v4'; z.coerce.number();`),
    bad(`${z}z['coerce'].number();`),
    bad(z + 'z[`coerce`].number();'),
    bad(`${z}const key = 'co' + 'erce'; z[key].number();`),
    bad(`${z}const key = getKey(); z[key].number();`),
    bad(`${z}const { coerce: c } = z; c.number();`),
    bad(`${z}let c; ({ coerce: c } = z);`),
    { ...bad(`export { z } from 'zod';`, 'escape'), filename: `${ROOT}packages/config/src/env.ts` },
    bad(`const { z: { coerce: c } } = require('zod');`),
    bad(`const schema = require('zod'); schema.coerce.number();`),
    bad(`const { z: schema } = require('zod'); schema.coerce.number();`),
    bad(`const { coerce: c } = require('zod'); c.number();`),
    bad(`${z}const schema = z; const second = schema; second.coerce.number();`),
    bad(`${z}let schema; schema = z; schema.coerce.number();`),
    bad(`${z}let schema = z.number(); schema = z; schema.coerce.number();`),
    bad(`${z}let p = z.string(); p = z.preprocess; p(callback, z.number());`, 'preprocess'),
    bad(`${z}(z as unknown as typeof z).coerce.number();`),
    bad(`${z}const load = z.number; load({ coerce: true });`),
    bad(`${z}z.number({ coerce: true });`),
    bad(`import { ZodNumber } from 'zod'; ZodNumber.create({ coerce: true });`),
    bad(`import { ZodNumber as N } from 'zod'; new N({ coerce: true });`),
    bad(`${z}z.string({ ['coerce']: true });`),
    bad(`${z}const options = { coerce: true }; z.number(options);`),
    bad(`${z}z.number(getOptions());`),
    bad(`${z}let options = {}; options = { coerce: true }; z.number(options);`),
    bad(`import { ZodNumber } from 'zod'; new ZodNumber(getOptions());`),
    bad(`${z}z.number({ ...getOptions() });`),
    bad(`${z}const options = {}; options.coerce = true; z.number(options);`),
    bad(`${z}const options = { coerce: false }; options.coerce++; z.number(options);`),
    bad(`${z}const options = {}; Object.assign(options, { coerce: true }); z.number(options);`),
    bad(`${z}const options = {}; const alias = options; mutate(alias); z.number(options);`),
    bad(`${z}const options = {}; mutate(options as object); z.number(options);`),
    bad(`${z}const options = { coerce: true }; z.number({ ...options });`),
    bad(`${z}z.date({ coerce: flag });`),
    bad(`export { z } from 'zod';`, 'escape'),
    bad(`export * from 'zod';`, 'escape'),
    bad(`export * as schema from 'zod';`, 'escape'),
    bad(`export { coerce } from 'zod';`, 'escape'),
    bad(`${z}export { z as schema };`, 'escape'),
    bad(`${z}export const schema = z;`, 'escape'),
    bad(`${z}export default z;`, 'escape'),
    bad(`${z}const factory = z.number; export { factory };`, 'escape'),
    bad(`${z}function helper() { return z; }`, 'escape'),
    bad(`module.exports = require('zod');`, 'escape'),
    bad(`${z}z.preprocess(v => Number(v), z.number());`, 'preprocess'),
    bad(
      `${z}const convert = v => Number(v); z.preprocess(v => convert(v), z.number());`,
      'preprocess',
    ),
    bad(
      `${z}import { convert } from './helper'; z.preprocess(v => convert(v), z.number());`,
      'preprocess',
    ),
    bad(`${z}z.preprocess(v => helper.convert(v), z.number());`, 'preprocess'),
    bad(`${z}z.preprocess(v => helper.replace(v), z.number());`, 'preprocess'),
    {
      ...bad(`${z}z.preprocess(v => BigInt(v), z.bigint());`, 'preprocess'),
      filename: `${ROOT}packages/contracts/src/common/number-input.ts`,
    },
    bad(`${z}z.preprocess(v => BigInt(v), z.bigint());`, 'preprocess'),
    bad(`${z}z.preprocess(v => typeof v === 'string' ? BigInt(v) : v, z.bigint());`, 'preprocess'),
    bad(`${z}z.preprocess(v => typeof v === 'string' ? Number(v) : v, z.number());`, 'preprocess'),
    ...['parseInt', 'parseFloat', 'Number.parseInt', 'globalThis.Number', 'Number.call'].map(
      (callee) => bad(`${z}z.preprocess(v => ${callee}(v), z.number());`, 'preprocess'),
    ),
    bad(`${z}const convert = Number; z.preprocess(v => convert(v), z.number());`, 'preprocess'),
    bad(`${z}const callback = v => v; z.preprocess(callback, z.number());`, 'preprocess'),
    bad(
      `${z}import { callback } from './helper'; z.preprocess(callback, z.number());`,
      'preprocess',
    ),
    bad(`${z}const { preprocess: p } = z; p(callback, z.number());`, 'preprocess'),
    bad(`${z}let p; ({preprocess: p} = z); p(callback, z.number());`, 'preprocess'),
    bad(`import { 'preprocess' as p } from 'zod'; p(callback, {});`, 'preprocess'),
    bad(`const { preprocess: p } = require('zod'); p(callback, {});`, 'preprocess'),
    { ...bad(`${z}z.coerce.number();`), filename: `${ROOT}apps/web/src/other/env.ts` },
    { ...bad(`${z}z.coerce.number();`), filename: `${ROOT}packages/other/src/env-issues.spec.ts` },
  ],
});

// Round 2: each row reproduces a review trigger; reject the class across aliases/options.
const formats = `int float32 float64 int32 uint32 int64 uint64 email guid uuid uuidv4 uuidv6
  uuidv7 url httpUrl emoji nanoid cuid cuid2 ulid xid ksuid ipv4 mac ipv6 cidrv4 cidrv6 base64 base64url
  e164 creditCard iban hostname hex currencyCode jwt iso.datetime iso.date iso.time iso.duration`.split(
  /\s+/,
);
const regressions = {
  F1: [
    `z.any().parse(z.number()).clone(getOptions());`,
    `z.parse(z.unknown(), z.number()).clone(getOptions());`,
    `import {z as legacy} from 'zod/v3'; legacy.number({__proto__: {coerce: true}});`,
    `z.int({get error() { this.coerce = true; return undefined; }});`,
    `z.number({message: 'invalid', set error(value) { this.coerce = true; }});`,
    ...['String', 'Number', 'Boolean', 'Bigint', 'Date'].map(
      (name) => `z.core._coerced${name}(z.Zod${name === 'Bigint' ? 'BigInt' : name}, {});`,
    ),
    ...formats.map((name) => `const opts = {}; opts.coerce = true; z.${name}(opts);`),
    `const f = z.int; f(getOptions());`,
    `z.email({ ...getOptions() });`,
    `z.hash('sha256', getOptions());`,
    `z.stringFormat('custom', /a/, getOptions());`,
    ...['ZodNumberFormat', 'ZodBigIntFormat', 'ZodMiniNumber'].map((name) =>
      name === 'ZodMiniNumber'
        ? `import { ZodMiniNumber } from 'zod/mini'; new ZodMiniNumber(getOptions());`
        : `new z.${name}(getOptions());`,
    ),
    `z.clone(z.number(), getOptions());`,
    `z.number().clone(getOptions());`,
    `z.number().optional().unwrap().clone(getOptions());`,
    `const copy = z.number().clone; copy(getOptions());`,
    `const copy = z.number().clone; export { copy };`,
    `const C = z.number().constructor; new C(getOptions());`,
    `const opts = {}; const alias = opts; Object.assign(alias, {coerce: true}); z.int(opts);`,
    `z.int({ ...{coerce: true} });`,
    `z.core._int(z.ZodNumberFormat, getOptions());`,
    `z.core._isoDateTime(z.ZodISODateTime, getOptions());`,
    `z.core._stringFormat(z.ZodCustomStringFormat, 'custom', /a/, getOptions());`,
  ],
  F2: [
    `let s = z.number().parse(1); s = z.number(); s.clone(getOptions());`,
    `let C = z.ZodNumberFormat; new C(getOptions()); C = z.ZodObject;`,
    `let C = z.ZodObject; C = z.ZodNumberFormat; new C(getOptions());`,
    `let f = z.number().safeParse; ({clone: f} = z.number()); f(getOptions());`,
    `let f = z.number().safeParse; f = z.number().clone; f(getOptions());`,
    `let f = z.object; f = z.preprocess; f(v => Number(v), z.number());`,
    `let f; f = z.transform; f(Number);`,
    `let f = z.object; ({preprocess: f} = z); f(v => Number(v), z.number());`,
    `let convert = v => v; convert = Number; z.preprocess(v => convert(v), z.number());`,
    `function convert(v) { return v; } convert = Number; z.preprocess(v => convert(v), z.number());`,
    `let convert = v => v; convert = v => Number(v); z.preprocess(v => convert(v), z.number());`,
    `let convert; ({convert} = {convert: Number}); z.preprocess(v => convert(v), z.number());`,
    `let opts = 'message'; opts = {}; Object.assign(opts, {coerce: true}); z.number(opts);`,
    `let opts = 'message'; opts = {}; const alias = opts; mutate(alias); z.int(opts);`,
  ],
  F3: [
    `z.preprocess((v, ctx, n = Number(v)) => n, z.number());`,
    `z.preprocess((v, ctx, {n = Number(v)} = {}) => n, z.number());`,
    `const f = (v, n = Number(v)) => n; z.preprocess(v => f(v), z.number());`,
    `function f(v, {n = Number(v)} = {}) { return n; } z.preprocess(v => f(v), z.number());`,
  ],
};
const positives = [
  `const data = z.any().parse({preprocess: f => f(1)}); data.preprocess(Number);`,
  `const data = z.object({clone:z.string(),constructor:z.string()}).parse({clone:'x',constructor:'y'}); const {clone,constructor}=data; export {clone,constructor};`,
  `const meta = z.string().meta({clone:'label',constructor:'label'}).meta(); export const label=meta.clone; export const ctor=meta.constructor;`,
  `const shape = z.object({clone:z.string()}).shape; export const field=shape.clone;`,
  `z.object({get coerce() {return z.boolean();}});`,
  `z.regexes.string(getOptions());`,
  `export {regexes} from 'zod';`,
  `import {ZodError} from 'zod/v3'; ZodError.create([]);`,
  `import {z as legacy} from 'zod/v3'; legacy.ZodObject.create({coerce: legacy.boolean()});`,
  `import {z as legacy} from 'zod/v3'; legacy.ZodEnum.create(['coerce', 'other']);`,
  ...['object', 'strictObject', 'looseObject'].map((name) => `z.${name}({coerce: z.boolean()});`),
  `z.enum({coerce: 'value'});`,
  ...['parse', 'safeParse', 'parseAsync', 'safeParseAsync'].map(
    (name) => `z.${name}(z.object({}), {coerce: true});`,
  ),
  `z.meta({coerce: true});`,
  `z.object({}).meta({coerce: true});`,
  `export { ZodError, NEVER, ZodIssueCode } from 'zod';`,
  `export { ZodError as Error } from 'zod/v4';`,
  `const {ZodError, NEVER, ZodIssueCode} = z; export {ZodError, NEVER, ZodIssueCode};`,
  `z.int({coerce: false});`,
  `z.core._int(z.ZodNumberFormat, {coerce: false});`,
  `const opts = {coerce: false}; z.number().clone(opts);`,
  `z.object({}).clone({type: 'object', shape: {coerce: z.boolean()}});`,
  `z.hash('sha256', {coerce: false});`,
  `z.stringFormat('custom', /a/, {coerce: false});`,
];
// Use diagnostic presence: fail-closed ambiguity may report more than one unsafe path.
import { Linter } from 'eslint';
import assert from 'node:assert/strict';
const linter = new Linter();
const messages = (code) =>
  linter.verify(z + code, [
    {
      languageOptions: { parser: tseslint.parser },
      plugins: { boundary: { rules: { coercion: rule } } },
      rules: { 'boundary/coercion': 'error' },
    },
  ]);
for (const [finding, cases] of Object.entries(regressions))
  for (const [index, code] of cases.entries())
    it(`${finding} review trigger ${index + 1}: ${code}`, () => {
      const diagnostics = messages(code);
      assert.ok(
        diagnostics.some((m) => m.ruleId === 'boundary/coercion'),
        JSON.stringify(diagnostics),
      );
    });
for (const [index, code] of positives.entries())
  it(`F4 safe syntax ${index + 1}: ${code}`, () => assert.deepEqual(messages(code), []));

const provenanceFailures = [
  `function apply(f,v) { return f(v); } z.preprocess(v=>apply(Number,v),z.number());`,
  `function get() { return Number; } z.preprocess(v=>get()(v),z.number());`,
  `const get=()=>Number; const f=get(); z.preprocess(v=>f(v),z.number());`,
  `const get=()=>Number; const f=get(); z.preprocess((v,n=f(v))=>n,z.number());`,
  `function f(v,{n=Number(v)}={}) { return n; } z.preprocess(v=>f(v),z.number());`,
  `import {normalizePersianText} from 'unreviewed'; z.preprocess(v=>normalizePersianText(v),z.string());`,
  `import {normalizePersianText} from '@/lib/format'; z.preprocess(v=>normalizePersianText(v),z.string());`,
  `import {parseMoneyInput} from '@/lib/format'; z.preprocess(v=>parseMoneyInput(v),z.bigint());`,
  `z.preprocess(v=>new Promise(Number),z.number());`,
  `z.preprocess(v=>setTimeout(Number,1),z.number());`,
];
for (const code of provenanceFailures)
  it(`F3 helper provenance refusal: ${code}`, () =>
    assert.ok(
      messages(code).some((m) => m.ruleId === 'boundary/coercion'),
      code,
    ));
for (const code of [
  `function apply(f,v) { return f(v); } z.preprocess(v=>apply(n=>n,v),z.unknown());`,
  `z.preprocess(v=>new Promise(resolve=>setTimeout(resolve,1)),z.unknown());`,
  `function f(v) { return v.trim(); } z.preprocess(v=>typeof v==='string'?f(v):v,z.string());`,
  `import {normalizePersianText} from '@/lib/format'; z.preprocess(v=>typeof v==='string'?normalizePersianText(v):v,z.string());`,
  `import {parseMoneyInput} from '@/lib/format'; z.preprocess(v=>typeof v==='string'?parseMoneyInput(v):v,z.bigint());`,
])
  it(`F3 proven helper call: ${code}`, () => assert.deepEqual(messages(code), []));

import { mkdtempSync, cpSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedCallbackHelper } from './zod-callback-helpers.mjs';
it('reviewed helper provenance refuses unknown, missing and changed source', () => {
  const root = mkdtempSync(join(tmpdir(), 'rasta-zod-helper-'));
  try {
    assert.equal(
      verifiedCallbackHelper(root, 'apps/web/src/lib/format', 'toLatinDigits'),
      undefined,
    );
    cpSync(join(ROOT, 'apps/web/src/lib/format'), join(root, 'apps/web/src/lib/format'), {
      recursive: true,
    });
    assert.equal(
      verifiedCallbackHelper(root, 'apps/web/src/lib/format', 'toLatinDigits'),
      'string',
    );
    assert.equal(verifiedCallbackHelper(root, 'apps/web/src/lib/format', 'unknown'), undefined);
    appendFileSync(join(root, 'apps/web/src/lib/format/digits.ts'), '\n// changed helper\n');
    assert.equal(
      verifiedCallbackHelper(root, 'apps/web/src/lib/format', 'toLatinDigits'),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
