import { createHash } from 'node:crypto';
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
const messages = (code, module) =>
  linter.verify(
    (module ? `import * as z from '${module}'; ` : z) + code,
    [
      {
        languageOptions: { parser: tseslint.parser },
        plugins: { boundary: { rules: { coercion: rule } } },
        rules: { 'boundary/coercion': 'error' },
      },
    ],
    { filename: `${ROOT}apps/web/src/probe.js` },
  );
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
  `function factory(){if(true)return Number;return v=>v;} z.preprocess(v=>factory()(v),z.number());`,
  `const factory=()=>{while(true){return BigInt;}return v=>v;}; z.preprocess(v=>factory()(v),z.bigint());`,
  `function factory(){if(true)return String;return v=>v;} z.preprocess(v=>factory()(v),z.string());`,
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
  `function factory(){if(false)throw new Error('unused');return v=>v;} z.preprocess(v=>factory()(v),z.unknown());`,
  `z.preprocess(v=>new Promise(resolve=>setTimeout(resolve,1)),z.unknown());`,
  `function f(v) { return v.trim(); } z.preprocess(v=>typeof v==='string'?f(v):v,z.string());`,
  `import {normalizePersianText} from '@/lib/format'; z.preprocess(v=>typeof v==='string'?normalizePersianText(v):v,z.string());`,
  `import {parseMoneyInput} from '@/lib/format'; z.preprocess(v=>typeof v==='string'?parseMoneyInput(v):v,z.bigint());`,
])
  it(`F3 proven helper call: ${code}`, () => assert.deepEqual(messages(code), []));

import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  appendFileSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    // The reviewed current formatter delegates fixed messages to this source.
    cpSync(
      join(ROOT, 'apps/web/src/lib/form-issues.ts'),
      join(root, 'apps/web/src/lib/form-issues.ts'),
    );
    assert.equal(
      verifiedCallbackHelper(root, 'apps/web/src/lib/format', 'toLatinDigits'),
      'string',
    );
    assert.equal(verifiedCallbackHelper(root, 'apps/web/src/lib/format', 'unknown'), undefined);
    for (const [module, name] of [
      ['drivers', 'localDateToIso'],
      ['usage', 'localDateTimeToIso'],
    ]) {
      cpSync(
        join(ROOT, `apps/web/src/server/${module}.ts`),
        join(root, `apps/web/src/server/${module}.ts`),
      );
      assert.equal(verifiedCallbackHelper(root, `apps/web/src/server/${module}`, name), 'verified');
    }
    cpSync(
      join(ROOT, 'apps/web/src/lib/repair-order-fields.ts'),
      join(root, 'apps/web/src/lib/repair-order-fields.ts'),
    );
    assert.equal(
      verifiedCallbackHelper(root, 'apps/web/src/lib/repair-order-fields', 'MAX_AMOUNT_MINOR'),
      'money-limit',
    );
    appendFileSync(join(root, 'apps/web/src/lib/repair-order-fields.ts'), '\n// changed source\n');
    assert.equal(
      verifiedCallbackHelper(root, 'apps/web/src/lib/repair-order-fields', 'MAX_AMOUNT_MINOR'),
      undefined,
    );
    appendFileSync(join(root, 'apps/web/src/lib/format/digits.ts'), '\n// changed helper\n');
    assert.equal(
      verifiedCallbackHelper(root, 'apps/web/src/lib/format', 'toLatinDigits'),
      undefined,
    );
    assert.equal(
      verifiedCallbackHelper(root, 'apps/web/src/server/drivers', 'localDateToIso'),
      undefined,
    );
    assert.equal(
      verifiedCallbackHelper(root, 'apps/web/src/server/usage', 'localDateTimeToIso'),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('FU-069b reviewed ISO check refuses contracts barrel or package entry drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'rasta-zod-contract-check-'));
  try {
    for (const file of [
      'packages/contracts/src/index.ts',
      'packages/contracts/src/common/iso-datetime.ts',
      'packages/contracts/package.json',
      'packages/contracts/src/common/pattern-refinement.ts',
    ])
      cpSync(join(ROOT, file), join(root, file));
    assert.equal(verifiedCallbackHelper(root, '@rasta/contracts', 'isoDateTime'), 'check');
    appendFileSync(join(root, 'packages/contracts/package.json'), '\n');
    assert.equal(verifiedCallbackHelper(root, '@rasta/contracts', 'isoDateTime'), undefined);
    cpSync(
      join(ROOT, 'packages/contracts/package.json'),
      join(root, 'packages/contracts/package.json'),
    );
    appendFileSync(join(root, 'packages/contracts/src/index.ts'), '\n// changed barrel\n');
    assert.equal(verifiedCallbackHelper(root, '@rasta/contracts', 'isoDateTime'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('FU-181 refuses the stale partial contracts barrel', () => {
  const root = mkdtempSync(join(tmpdir(), 'rasta-zod-stale-barrel-'));
  try {
    for (const file of [
      'packages/contracts/src/index.ts',
      'packages/contracts/src/common/iso-datetime.ts',
      'packages/contracts/src/common/pattern-refinement.ts',
    ])
      cpSync(join(ROOT, file), join(root, file));
    const barrel = join(root, 'packages/contracts/src/index.ts');
    const stale = readFileSync(barrel, 'utf8')
      .replace(
        "export { parsableUrl, isParsableUrlCheck } from './common/parsable-url';",
        "export { parsableUrl } from './common/parsable-url';",
      )
      .replace(/export \{[^}]*\} from '\.\/common\/transaction-text';\n/, '')
      .replace(
        /export \{[^}]*PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS,[^}]*\} from '\.\/common\/replay-window';/,
        "export { PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS } from './common/replay-window';",
      )
      .replace(
        /export \{[^}]*publishedRefinementPattern,[^}]*\} from '\.\/common\/pattern-refinement';/,
        "export { patternRefinement, publishedRefinementPattern } from './common/pattern-refinement';",
      );
    writeFileSync(barrel, stale);
    assert.equal(
      createHash('sha256').update(stale).digest('hex'),
      '292d4fef2cb013e364ea7dd29ef04b112bf64734394155147d7dee955d91f770',
    );
    assert.equal(verifiedCallbackHelper(root, '@rasta/contracts', 'isoDateTime'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// F3 transform family: every callback entry uses the same fail-closed helper analysis.
const transformFailures = [
  `import {formMessage} from 'unknown'; z.string().min(1,formMessage('Required')).transform(Number);`,
  `import {formMessage} from '@/lib/form-issues'; z.string().min(1,formMessage(unknown)).transform(Number);`,
  `import {moneyInputMessage} from '@/lib/format'; z.transform(v=>moneyInputMessage(v,unknown));`,
  `import {IRR} from '@/lib/format'; z.transform(v=>IRR(v));`,
  `z.core._string(z.ZodTransform,{transform:Number});`,
  `z.core._int(z.ZodTransform,{transform:(v,ctx,n=Number(v))=>n});`,
  `const C=z.ZodTransform; z.core._url(C,{transform:Number});`,
  `import {z as legacy} from 'zod/v3'; z.core._string(legacy.ZodEffects,{schema:legacy.unknown(),effect:{type:'transform',transform:Number}});`,
  `z.string({checks:[z.overwrite(()=>true)]}).transform(Number);`,
  `const opts={checks:[z.overwrite(()=>true)]}; z.string(opts).transform(Number);`,
  `z.array(z.string(),{checks:[z.overwrite(()=>[true])]}).transform(v=>v.map(Number));`,
  ...['min(0', 'max(1000', 'length(1', 'regex(/.*/'].map(
    (method) => `z.string().${method},{when:p=>{p.value=true;return false;}}).transform(Number);`,
  ),
  `z.string().nonempty({when:p=>{p.value=true;return false;}}).transform(Number);`,
  `const opts={when:p=>{p.value=true;return false;}}; z.string().regex(/.*/,opts).transform(Number);`,
  `z.string().regex(/.*/,{...{when:p=>{p.value=true;return false;}}}).transform(Number);`,
  `z.core._url(getConstructor(),{});`,
  `z.core._int(getConstructor(),{});`,
  `let C=z.core.$ZodString; C=unresolved; z.core._string(C,{});`,
  `z.core._transform(getConstructor(),v=>v);`,
  `import {C} from 'unknown'; z.core._transform(C,v=>v);`,
  `function build(C) { return z.core._transform(C,v=>v); }`,
  `let C=z.core.$ZodTransform; C=unresolved; z.core._transform(C,v=>v);`,
  `let C=z.ZodTransform; ({C}=getConstructors()); z.core._transform(C,v=>v);`,
  `import {MAX_AMOUNT_MINOR} from 'unknown'; z.transform(()=>BigInt(MAX_AMOUNT_MINOR));`,
  `import {MAX_AMOUNT_MINOR} from '@/lib/repair-order-fields'; z.transform(v=>MAX_AMOUNT_MINOR('1'));`,
  `import {other} from '@/lib/repair-order-fields'; z.transform(()=>BigInt(other));`,
  `const def={effect:{type:'transform',transform:v=>v}}; def.effect.transform=Number; new z.ZodEffects(def);`,
  `const def={effect:{type:'transform',transform:v=>v}}; const effect=def.effect; effect.transform=Number; new z.ZodEffects(def);`,
  `const def={effect:{type:'transform',transform:v=>v}}; mutate(def.effect); new z.ZodEffects(def);`,
  `z.array(z.string()).refine(v=>{v[0]=true;return true;}).transform(v=>v.map(Number));`,
  `const mutate=v=>{v[0]=true;return true;}; z.array(z.string()).refine(mutate).transform(v=>v.map(Number));`,
  `const C=z.transform(()=>'1').constructor; new C({type:'transform',transform:Number});`,
  `z.transform(()=>'1').clone({type:'transform',transform:Number});`,

  `new z.ZodTransform({type:'transform', __proto__:{transform:Number}});`,
  `z.string().check(ctx=>{ctx.value=true;}).transform(Number);`,
  `z.string().superRefine((v,ctx)=>{ctx.value=true;}).transform(Number);`,
  `z.string().refine(()=>true,{when:ctx=>{ctx.value=true;return true;}}).transform(Number);`,

  `z.transform(v=>Number.call('validated-this',v));`,
  `z.transform(v=>Number.apply('validated-this',[v]));`,
  `const f=Number.call; z.transform(v=>f('validated-this',v));`,
  `const f=Number.apply; z.transform(v=>f('validated-this',[v]));`,
  `z.transform(v=>globalThis.String.call('validated-this',v));`,
  `const f=Boolean.bind(null); z.transform(f);`,

  `const def={type:'transform',transform:v=>v}; const alias=def; alias.transform=Number; new z.ZodTransform(def);`,
  `const def={type:'transform',transform:v=>v}; Object.assign(def,{transform:Number}); new z.ZodTransform(def);`,
  `const def={type:'transform',transform:v=>v}; mutate(def); new z.ZodTransform(def);`,
  `const def={type:'transform',transform:v=>v, mutate(){this.transform=Number;}}; def.mutate(); new z.ZodTransform(def);`,

  ...['Number', 'BigInt', 'String', 'Boolean', 'Date', 'parseInt', 'parseFloat'].flatMap(
    (convert) => [`z.unknown().transform(${convert});`, `z.transform(${convert});`],
  ),
  `const f = async v => Number(v); z.unknown().transform(f);`,
  `function f(v, n = Number(v)) { return n; } z.unknown().transform(f);`,
  `const f = (v, {n = Number(v)} = {}) => n; z.unknown().transform(f);`,
  `const f = (v, n = Number(v)) => n; z.unknown().transform(v => f(v));`,
  `const f = (v, {n = Number(v)} = {}) => n; z.unknown().transform(v => f(v));`,
  `function apply(f,v) { return f(v); } z.transform(v => apply(Number,v));`,
  `function get() { return Number; } z.transform(get());`,
  `const get = () => Number; z.transform(get());`,
  `const get = () => Number; const f = get(); z.transform(f);`,
  `const f = opaque; z.transform(f);`,
  `import { convert } from 'unknown'; z.unknown().transform(v => convert(v));`,
  `import { normalizePersianText } from '@/lib/format'; z.transform(normalizePersianText);`,
  `z.unknown().pipe(z.transform(Number));`,
  `z.pipe(z.unknown(), z.transform(Number));`,
  `const {transform: f} = z.unknown(); f(Number);`,
  `const f = z.unknown().transform; f(Number);`,
  `let f = z.string().transform; f = v => v; f(Number);`,
  `z.unknown()[method](Number);`,
  ...['transform', 'preprocess'].map(
    (field) =>
      `new z.ZodEffects({effect: {type: '${field}', ${field}: Number}, schema: z.unknown()});`,
  ),
  ...['ZodTransform', 'ZodMiniTransform', 'core.$ZodTransform'].map(
    (type) => `new z.${type}({type: 'transform', transform: Number});`,
  ),
  `z.ZodTransform({type: 'transform', transform: Number});`,
  `z.ZodTransform.init({}, {type: 'transform', transform: Number});`,
  `z.ZodTransform.create({type: 'transform', transform: Number});`,
  `z.core._transform(z.core.$ZodTransform, Number);`,
  `z.ZodEffects.createWithPreprocess(Number, z.number());`,
  `z.clone(z.transform(v => v), {type: 'transform', transform: Number});`,
  `z.transform(v => v).clone({type: 'transform', transform: Number});`,
  `const def = {type:'transform',transform:Number}; new z.ZodTransform(def);`,
  `const def = {type:'transform',transform:v=>v}; def.transform=Number; new z.ZodTransform(def);`,
  `new z.ZodTransform(getDefinition());`,
  `new z.ZodTransform({...getDefinition()});`,
  `new z.ZodTransform({get transform() { return Number; }});`,
  ...['z.overwrite', 'z.unknown().overwrite', 'z.core._overwrite'].map((api) => `${api}(Number);`),
  `new z.core.$ZodCheckOverwrite({check:'overwrite',tx:Number});`,
  `z.check(z.overwrite(Number));`,
  `z.unknown().transform((v, n=Number(v))=>n);`,
  `z.unknown().overwrite((v, {n=Number(v)}={})=>n);`,
  `z.array(z.unknown()).transform(v=>v.map(Number));`,
  `z.array(z.unknown()).transform(v=>v.map(n=>Number(n)));`,
  `z.string().transform(v=>opaque.trim(v));`,
  `z.unknown().transform(v=>setTimeout(Number,1));`,
  `z.unknown().transform(v=>new Promise(Number));`,
  `z.unknown().transform((v: string)=>Number(v));`,
  `let s=z.string(); s=z.unknown(); s.transform(Number);`,
];
for (const [index, code] of transformFailures.entries())
  it(`F3 transform refusal ${index + 1}: ${code}`, () =>
    assert.ok(
      messages(code).some((m) => m.ruleId === 'boundary/coercion'),
      code,
    ));
for (const code of [
  `import {formMessage} from '@/lib/form-issues'; z.string().min(1,formMessage('Required')).transform(Number);`,
  "import {formMessage} from '@/lib/form-issues'; z.string().regex(/.*/,formMessage(`Bound ${1}`)).transform(Number);",
  `import {moneyInputMessage,IRR} from '@/lib/format'; z.transform(v=>moneyInputMessage(v,IRR));`,
  `import {formMessage} from '@/lib/form-issues'; z.codec(z.string().min(1,formMessage('Input')),z.string().min(1,formMessage('Output')),{decode:Number,encode:Number});`,
  `import {MAX_AMOUNT_MINOR} from '@/lib/repair-order-fields'; z.transform(()=>BigInt(MAX_AMOUNT_MINOR));`,
  `z.string({error:'Required'}).min(1,{message:'Length'}).transform(Number);`,
  'z.string().min(1, `Known bound ${1}`).transform(Number);',
  `z.string().meta({when:'data',coerce:true}).transform(Number);`,
  `z.array(z.string(),{error:'Array'}).transform(v=>v.map(Number));`,
  `z.string().min(0,undefined).transform(Number);`,
  `z.string().regex(/.*/).transform(Number);`,
  `z.string().transform(Number);`,
  `z.string().transform(v=>Number(v));`,
  `const f=async v=>Number(v); z.string().transform(f);`,
  `function f(v) { return Number(v); } z.string().transform(f);`,
  `const f=v=>Number(v); const alias=f; z.string().transform(alias);`,
  `const f=v=>v; z.unknown().transform(f);`,
  `const factory=()=>v=>v; z.unknown().transform(factory());`,
  `z.string().transform(v=>v.trim().toUpperCase());`,
  `z.array(z.string()).transform(v=>v.map(Number));`,
  `z.array(z.number()).transform(v=>v.reverse());`,
  `z.string().transform(v=>v.split(',').map(n=>n.trim()));`,
  `z.string().transform(v=>v.replace(/x/g, 'y'));`,
  `z.unknown().transform(v=>typeof v==='string'?Number(v):v);`,
  `const helper=v=>Number(v); z.unknown().transform(v=>typeof v==='string'?helper(v):v);`,
  `import {normalizePersianText} from '@/lib/format'; z.string().transform(normalizePersianText);`,
  `import {parseMoneyInput} from '@/lib/format'; z.string().transform(parseMoneyInput);`,
  `z.unknown().transform(v=>new Promise(resolve=>setTimeout(resolve,1)));`,
  `z.core._transform(z.core.$ZodTransform, v=>v);`,
  `const C=z.core.$ZodTransform; z.core._transform(C,v=>v);`,
  `new z.ZodTransform({type:'transform',transform:v=>v});`,
  `const def={type:'transform',transform:v=>v}; new z.ZodTransform(def);`,
  `z.unknown().overwrite(v=>v);`,
  `new z.core.$ZodCheckOverwrite({check:'overwrite',tx:v=>v});`,
])
  it(`F3 verified transform: ${code}`, () => assert.deepEqual(messages(code), []));

it('F3 keeps a validated string receiver through a method alias', () =>
  assert.deepEqual(messages(`const f=z.string().transform; f(Number);`), []));

// F3 codecs validate decode against `in` and encode against `out` independently.
for (const code of [
  `z.core._int(z.ZodCodec,{in:z.unknown(),out:z.number(),transform:Number,reverseTransform:v=>v});`,
  `z.core._string(z.ZodCodec,{in:z.number(),out:z.unknown(),transform:v=>v,reverseTransform:Number});`,
  `z.codec(z.string({checks:[z.overwrite(()=>true)]}),z.number(),{decode:Number,encode:v=>v});`,
  `z.codec(z.number(),z.string().min(0,{when:p=>{p.value=true;return false;}}),{decode:v=>v,encode:Number});`,
  `new z.ZodCodec({type:'pipe',in:z.string({checks:[z.overwrite(()=>true)]}),out:z.number(),transform:Number,reverseTransform:v=>v});`,
  `z.codec(z.unknown(),z.number(),{decode:Number,encode:v=>v});`,
  `z.codec(z.number(),z.unknown(),{decode:v=>v,encode:Number});`,
  `const f=async v=>Number(v); z.codec(z.unknown(),z.number(),{decode:f,encode:v=>v});`,
  `z.codec(z.unknown(),z.number(),{decode:(v,n=Number(v))=>n,encode:v=>v});`,
  `z.codec(z.number(),z.unknown(),{decode:v=>v,encode:(v,{n=Number(v)}={})=>n});`,
  `const helper=(v,n=Number(v))=>n; z.codec(z.unknown(),z.number(),{decode:v=>helper(v),encode:v=>v});`,
  `z.codec(z.string(),z.number(),getOptions());`,
  `z.codec(z.string(),z.number(),{...getOptions()});`,
  `const opts={decode:v=>v,encode:v=>v}; const alias=opts; alias.decode=Number; z.codec(z.unknown(),z.number(),opts);`,
  `const opts={decode:v=>v,encode:v=>v}; Object.assign(opts,{encode:Number}); z.codec(z.unknown(),z.number(),opts);`,
  `z.codec(z.unknown(),z.number(),{get decode(){return Number},encode:v=>v});`,
  `z.codec(z.unknown(),z.number(),{decode:unknownHelper,encode:v=>v});`,
  `z.unknown().pipe(z.codec(z.unknown(),z.number(),{decode:Number,encode:v=>v}));`,
  ...['ZodCodec', 'ZodMiniCodec', 'core.$ZodCodec'].flatMap((type) => [
    `new z.${type}({type:'pipe',in:z.unknown(),out:z.number(),transform:Number,reverseTransform:v=>v});`,
    `new z.${type}({type:'pipe',in:z.number(),out:z.unknown(),transform:v=>v,reverseTransform:Number});`,
  ]),
  `z.ZodCodec.init({}, {type:'pipe',in:z.unknown(),out:z.number(),transform:Number,reverseTransform:v=>v});`,
  `z.ZodCodec.create({type:'pipe',in:z.unknown(),out:z.number(),transform:v=>v,reverseTransform:Number});`,
])
  it(`F3 codec refuses: ${code}`, () => assert.ok(messages(code).length, code));
for (const code of [
  `z.codec(z.string(),z.number(),{decode:Number,encode:v=>v});`,
  `z.codec(z.number(),z.string(),{decode:v=>v,encode:Number});`,
  `const f=async v=>Number(v); z.codec(z.string(),z.number(),{decode:f,encode:v=>v});`,
  `new z.ZodCodec({type:'pipe',in:z.string(),out:z.string(),transform:Number,reverseTransform:Number});`,
  `z.codec(z.unknown(),z.unknown(),{decode:v=>v,encode:v=>v});`,
])
  it(`F3 codec preserves: ${code}`, () => assert.deepEqual(messages(code), []));

// Reviewed string canonicaliser (FU-084 `canonicalUniqueText`), allowed by binding, never by name.
// A callback that converts an input already proven to be a string is accepted by the rule's own
// design, so every refusal below uses a body or operand the baseline analysis refuses (BigInt of a
// non-literal, any conversion of an unproven value): only a wrongly granted allowance could pass it.
const UNIQUE_TEXT = 'packages/nest-common/src/text/canonical-unique-text';
const IMPORT_UNIQUE_TEXT = `import { canonicalUniqueText } from '../../../${UNIQUE_TEXT}'; `;
const PROBE = 'services/organization-service/src/probe.ts';
const uniqueTextMessages = (code, file = `${UNIQUE_TEXT}.ts`) =>
  linter.verify(
    z + code,
    [
      {
        files: ['**/*.ts', '**/*.tsx', '**/*.mjs', '**/*.js'],
        languageOptions: { parser: tseslint.parser },
        plugins: { boundary: { rules: { coercion: rule } } },
        rules: { 'boundary/coercion': 'error' },
      },
    ],
    { filename: `${ROOT}${file}` },
  );
const refused = (code, file) =>
  uniqueTextMessages(code, file).some((m) => m.ruleId === 'boundary/coercion');
const shape = (decl) =>
  `${decl} export function uniqueText(options) { return z.string().transform((raw, ctx) => { const canonical = canonicalUniqueText(raw, options); if (canonical === null) { ctx.addIssue({ code: 'custom', message: 'bad' }); return z.NEVER; } return canonical; }); }`;
const safeDecl = `function canonicalUniqueText(raw, options) { return raw; }`;
const coercingDecl = `function canonicalUniqueText(raw, options) { return BigInt(raw); }`;
it('canonicalUniqueText: the exact uniqueText shape passes in the pinned defining module', () => {
  assert.deepEqual(uniqueTextMessages(shape(safeDecl)), []);
});
it('canonicalUniqueText: the allowance is the pinned file, not the name or a sibling spelling', () => {
  // The same shape with a body the baseline refuses passes only where the pinned file vouches for it.
  assert.deepEqual(uniqueTextMessages(shape(coercingDecl)), []);
  for (const file of [
    'packages/nest-common/src/text/other.ts',
    `${UNIQUE_TEXT}.mjs`,
    `${UNIQUE_TEXT}.tsx`,
    `${UNIQUE_TEXT}.js`,
    'services/organization-service/src/canonical-unique-text.ts',
  ])
    assert.ok(refused(shape(coercingDecl), file), file);
});
it('canonicalUniqueText: an import carries the allowance only for the exact module', () => {
  const use = `z.string().transform((raw) => canonicalUniqueText(raw, { caseFold: false }) ?? '');`;
  for (const from of [`../../../${UNIQUE_TEXT}`, `../../../${UNIQUE_TEXT}.ts`])
    assert.deepEqual(
      uniqueTextMessages(`import { canonicalUniqueText } from '${from}'; ${use}`, PROBE),
      [],
      from,
    );
  assert.deepEqual(
    uniqueTextMessages(
      `import { canonicalUniqueText as c } from '../../../${UNIQUE_TEXT}'; z.string().transform((raw) => c(raw, { caseFold: true }) ?? '');`,
      PROBE,
    ),
    [],
  );
  // A const alias is the same binding; no other reading of the name is.
  assert.deepEqual(
    uniqueTextMessages(
      `${IMPORT_UNIQUE_TEXT}const alias = canonicalUniqueText; z.string().transform((raw) => alias(raw, { caseFold: false }) ?? '');`,
      PROBE,
    ),
    [],
  );
  for (const from of [
    // Sibling spellings and other modules that happen to export the same name.
    `../../../${UNIQUE_TEXT}.mjs`,
    `../../../${UNIQUE_TEXT}.js`,
    `../../../${UNIQUE_TEXT}.tsx`,
    '../../../packages/nest-common/src/text/other',
    `../../../${UNIQUE_TEXT}/`,
    `../../../${UNIQUE_TEXT}/.`,
    `../../../${UNIQUE_TEXT}/index`,
    '@rasta/nest-common',
    'unknown-package',
  ])
    assert.ok(refused(`import { canonicalUniqueText } from '${from}'; ${use}`, PROBE), from);
});
for (const code of [
  // A same-named local function or variable in any other file proves nothing.
  `function canonicalUniqueText(v) { return BigInt(v); } z.string().transform((raw) => canonicalUniqueText(raw));`,
  `const canonicalUniqueText = (v) => BigInt(v); z.string().transform((raw) => canonicalUniqueText(raw));`,
  `const canonicalUniqueText = Number; z.unknown().transform((raw) => canonicalUniqueText(raw));`,
  // A re-assigned alias, and a namespace member, never inherit the capability.
  `${IMPORT_UNIQUE_TEXT}let alias = canonicalUniqueText; alias = BigInt; z.string().transform((raw) => alias(raw));`,
  `${IMPORT_UNIQUE_TEXT}let alias = canonicalUniqueText; alias = Number; z.unknown().transform((raw) => alias(raw));`,
  `import * as text from '../../../${UNIQUE_TEXT}'; z.string().transform((raw) => text.canonicalUniqueText(raw));`,
  // The reviewed result is `string | null`, never a string proof for a conversion.
  `${IMPORT_UNIQUE_TEXT}z.string().transform((raw) => Number(canonicalUniqueText(raw, { caseFold: false })));`,
  `${IMPORT_UNIQUE_TEXT}z.string().transform((raw) => new Date(canonicalUniqueText(raw, { caseFold: false })));`,
  `${IMPORT_UNIQUE_TEXT}z.string().transform((raw) => BigInt(canonicalUniqueText(raw, { caseFold: false })));`,
  // A coercion of an unproven value beside the reviewed call.
  `${IMPORT_UNIQUE_TEXT}z.unknown().transform((raw) => { canonicalUniqueText('x', { caseFold: false }); return Number(raw); });`,
  `${IMPORT_UNIQUE_TEXT}z.unknown().transform((raw) => { canonicalUniqueText('x', { caseFold: false }); return new Date(raw); });`,
  `${IMPORT_UNIQUE_TEXT}z.unknown().transform((raw) => { canonicalUniqueText('x', { caseFold: false }); return BigInt(raw); });`,
  `${IMPORT_UNIQUE_TEXT}z.string().transform((raw) => { canonicalUniqueText(raw, { caseFold: false }); return BigInt(raw); });`,
  // The reviewed call is only for text: an unproven or converted argument is refused.
  `${IMPORT_UNIQUE_TEXT}z.unknown().transform((raw) => canonicalUniqueText(raw, { caseFold: false }));`,
  `${IMPORT_UNIQUE_TEXT}z.unknown().transform((raw) => canonicalUniqueText(Number(raw), { caseFold: false }));`,
])
  it(`canonicalUniqueText refused: ${code}`, () => assert.ok(refused(code, PROBE), code));
it('canonicalUniqueText: coercion beside the call inside the defining module is refused', () => {
  for (const body of [
    `return canonicalUniqueText(raw, options) ?? Number(ctx);`,
    `return canonicalUniqueText(raw, options) ?? new Date(ctx);`,
    `return canonicalUniqueText(raw, options) ?? BigInt(raw);`,
    `return Number(canonicalUniqueText(raw, options));`,
    `return canonicalUniqueText(Number(ctx), options);`,
  ])
    assert.ok(
      refused(`${safeDecl} z.string().transform((raw, ctx) => { ${body} });`, `${UNIQUE_TEXT}.ts`),
      body,
    );
  // Re-assigning the declared function in the defining module withdraws the allowance.
  assert.ok(
    refused(
      `${coercingDecl} canonicalUniqueText = Number; z.string().transform((raw) => canonicalUniqueText(raw));`,
      `${UNIQUE_TEXT}.ts`,
    ),
  );
  // So does a variable standing in for the declaration.
  assert.ok(
    refused(
      `const canonicalUniqueText = (raw) => BigInt(raw); z.string().transform((raw) => canonicalUniqueText(raw));`,
      `${UNIQUE_TEXT}.ts`,
    ),
  );
});
it('canonicalUniqueText: the pin matches the real source, and changed source refuses', () => {
  assert.equal(
    verifiedCallbackHelper(ROOT, UNIQUE_TEXT, 'canonicalUniqueText', {
      spelling: 'canonical-unique-text.ts',
      definition: 'FunctionName',
    }),
    'canonicalizer',
  );
  // No binding information, or a variable binding, never carries an `exact` allowance.
  assert.equal(verifiedCallbackHelper(ROOT, UNIQUE_TEXT, 'canonicalUniqueText'), undefined);
  assert.equal(
    verifiedCallbackHelper(ROOT, UNIQUE_TEXT, 'canonicalUniqueText', {
      spelling: 'canonical-unique-text',
      definition: 'Variable',
    }),
    undefined,
  );
  const root = mkdtempSync(join(tmpdir(), 'rasta-zod-unique-text-'));
  try {
    const target = join(root, `${UNIQUE_TEXT}.ts`);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(ROOT, `${UNIQUE_TEXT}.ts`), target);
    const binding = { spelling: UNIQUE_TEXT.split('/').pop(), definition: 'ImportBinding' };
    assert.equal(
      verifiedCallbackHelper(root, UNIQUE_TEXT, 'canonicalUniqueText', binding),
      'canonicalizer',
    );
    appendFileSync(target, '\n// changed source\n');
    assert.equal(
      verifiedCallbackHelper(root, UNIQUE_TEXT, 'canonicalUniqueText', binding),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The two other main-side hits of the merge train: `canonicalIdentifier` (asset-service) and the
// `isOrderCommand` predicate whose pinned source moved with #728, plus the string-schema factory
// `plainText()` that carries the string proof through `.pipe(plainText())`.
const ASSET = 'services/asset-service/src/asset/dto.ts';
const IDENTIFIER = 'services/asset-service/src/asset/identifier';
const IMPORT_IDENTIFIER = `import { canonicalIdentifier } from './identifier'; `;
const IMPORT_PLAIN = `import { plainText } from '@rasta/contracts'; `;
it('canonicalIdentifier: the asset DTO chain passes, by exact binding and string-schema proof', () => {
  for (const code of [
    `${IMPORT_IDENTIFIER}z.string().transform(canonicalIdentifier);`,
    `${IMPORT_IDENTIFIER}${IMPORT_PLAIN}z.string().min(3).max(9).pipe(plainText()).transform(canonicalIdentifier).pipe(z.string().min(3).max(9));`,
    `${IMPORT_IDENTIFIER}z.string().transform((v) => canonicalIdentifier(v));`,
  ])
    assert.deepEqual(uniqueTextMessages(code, ASSET), [], code);
});
for (const code of [
  // Another module, a sibling spelling, a same-named local, an unproven input, a coercion beside it.
  `import { canonicalIdentifier } from './identifier.mjs'; z.string().transform(canonicalIdentifier);`,
  `import { canonicalIdentifier } from './identifier.js'; z.string().transform(canonicalIdentifier);`,
  `import { canonicalIdentifier } from './identifier/'; z.string().transform(canonicalIdentifier);`,
  `import { canonicalIdentifier } from './identifier/.'; z.string().transform(canonicalIdentifier);`,
  `import { canonicalIdentifier } from './other'; z.string().transform(canonicalIdentifier);`,
  `import { canonicalIdentifier } from '@rasta/contracts'; z.string().transform(canonicalIdentifier);`,
  `function canonicalIdentifier(v) { return BigInt(v); } z.string().transform(canonicalIdentifier);`,
  `const canonicalIdentifier = BigInt; z.string().transform(canonicalIdentifier);`,
  `${IMPORT_IDENTIFIER}z.unknown().transform(canonicalIdentifier);`,
  `${IMPORT_IDENTIFIER}let alias = canonicalIdentifier; alias = Number; z.unknown().transform(alias);`,
  `${IMPORT_IDENTIFIER}z.unknown().transform((v) => { canonicalIdentifier('x'); return Number(v); });`,
  `${IMPORT_IDENTIFIER}z.string().transform((v) => BigInt(canonicalIdentifier(v)));`,
  // Without a string schema the pipe carries no proof; plainText must be the contracts export.
  `${IMPORT_IDENTIFIER}z.string().pipe(unknownSchema()).transform(canonicalIdentifier);`,
  `${IMPORT_IDENTIFIER}import { plainText } from './plain'; z.string().pipe(plainText()).transform(canonicalIdentifier);`,
  `${IMPORT_IDENTIFIER}function plainText() { return z.unknown(); } z.string().pipe(plainText()).transform(canonicalIdentifier);`,
  `${IMPORT_IDENTIFIER}${IMPORT_PLAIN}z.string().pipe(plainText(1)).transform(canonicalIdentifier);`,
  `${IMPORT_IDENTIFIER}${IMPORT_PLAIN}z.string().pipe(plainText).transform(canonicalIdentifier);`,
  `${IMPORT_PLAIN}z.string().transform(plainText);`,
])
  it(`canonicalIdentifier/plainText refused: ${code}`, () => assert.ok(refused(code, ASSET), code));
it('reviewed sources: every pin matches the real tree (drift fails here, with a name)', () => {
  const binding = { spelling: IDENTIFIER.split('/').pop(), definition: 'ImportBinding' };
  for (const [module, name, kind] of [
    [IDENTIFIER, 'canonicalIdentifier', 'string'],
    ['@rasta/contracts', 'plainText', 'string-schema'],
    ['apps/web/src/lib/order-fields', 'isOrderCommand', 'predicate'],
  ])
    assert.equal(
      verifiedCallbackHelper(ROOT, module, name, binding),
      kind,
      `${module} ${name}: its pinned source changed; review the helper again and re-pin it in scripts/zod-callback-helpers.mjs`,
    );
  const root = mkdtempSync(join(tmpdir(), 'rasta-zod-identifier-'));
  try {
    const target = join(root, `${IDENTIFIER}.ts`);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(ROOT, `${IDENTIFIER}.ts`), target);
    assert.equal(
      verifiedCallbackHelper(root, IDENTIFIER, 'canonicalIdentifier', binding),
      'string',
    );
    appendFileSync(target, '\n// changed source\n');
    assert.equal(
      verifiedCallbackHelper(root, IDENTIFIER, 'canonicalIdentifier', binding),
      undefined,
    );
    // A variable binding or a sibling spelling never carries the allowance.
    assert.equal(
      verifiedCallbackHelper(ROOT, IDENTIFIER, 'canonicalIdentifier', {
        spelling: 'identifier.mjs',
        definition: 'ImportBinding',
      }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
// F1: the reviewer's 41 executable escapes, including all 22 constructor
// detections present at 46422b9d. Mini unions have no public .options field.
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const contractsRequire = createRequire(
  new URL('../packages/contracts/package.json', import.meta.url),
);
const containerPaths = [
  `z.object({n:z.number()}).shape.n`,
  `z.union([z.number(),z.string()]).options[0]`,
  `z.xor([z.number(),z.string()]).options[0]`,
  `z.discriminatedUnion('k',[z.object({k:z.literal('a'),n:z.number()})]).options[0].shape.n`,
  ...['def', '_def', '_zod.def'].map((p) => `z.object({n:z.number()}).${p}.shape.n`),
  ...['left', 'right'].map((p) => `z.intersection(z.number(),z.number()).def.${p}`),
  `z.tuple([z.number()]).def.items[0]`,
  `z.tuple([]).rest(z.number()).def.rest`,
  `z.object({}).catchall(z.number()).def.catchall`,
  `z.number().optional().def.innerType`,
  `z.array(z.number()).def.element`,
  `z.record(z.string(),z.number()).def.valueType`,
  `z.map(z.number(),z.number()).def.keyType`,
  `z.set(z.number()).def.valueType`,
  `z.pipe(z.number(),z.number()).def.in`,
  `z.any().safeParse(z.number()).data`,
  `z.any().safeParse({...{n:z.number()},...{m:z.string()}}).data.n`,
  `z.any().safeParse({[(()=>'n')()]:z.number()}).data.n`,
];
const containerProbes = containerPaths.flatMap((path) => [
  ['zod', `const s=${path}.clone({coerce:true});`],
  ['zod', `const C=${path}.constructor; const s=new C({type:'number',coerce:true});`],
]);
for (const [module, paths] of [
  ['zod/mini', [containerPaths[0]]],
  ['zod/v3', containerPaths.slice(0, 2)],
])
  for (const path of paths)
    containerProbes.push([
      module,
      `const C=${path}.constructor; const s=new C({type:'number',typeName:'ZodNumber',checks:[],coerce:true});`,
    ]);
for (const [module, code] of containerProbes)
  it(`F1 executable container ${module}: ${code}`, () => {
    const diagnostics = messages(
      code.replaceAll('z.', 'schema.').replace(/^/, `const schema = z; `),
    );
    assert.ok(
      diagnostics.some((m) => m.messageId === 'boundary'),
      JSON.stringify(diagnostics),
    );
    const api = contractsRequire(module);
    const result = runInNewContext(
      `${code} z.safeParse ? z.safeParse(s,true) : s.safeParse(true);`,
      { z: api },
    );
    assert.equal(result.success, true);
    assert.equal(result.data, 1);
    // Exercise the actual import module as well as the renamed local alias.
    assert.ok(
      linter
        .verify(`import * as z from '${module}'; ${code}`, [
          {
            languageOptions: { parser: tseslint.parser },
            plugins: { boundary: { rules: { coercion: rule } } },
            rules: { 'boundary/coercion': 'error' },
          },
        ])
        .some((m) => m.messageId === 'boundary'),
    );
  });

for (const code of [
  `const shape=z.object({n:z.number()}).shape; const child=shape.n; child.clone({coerce:true});`,
  `const {shape:{n:child}}=z.object({n:z.number()}); child.clone({coerce:true});`,
  `const {n:child}=z.object({n:z.number()}).shape; child.clone({coerce:true});`,
  `const {...shape}=z.object({n:z.number()}).shape; shape.n.clone({coerce:true});`,
  `const {options:[child]}=z.union([z.number(),z.string()]); child.clone({coerce:true});`,
  `const [child]=z.union([z.number(),z.string()]).options; child.clone({coerce:true});`,
  `const [,...tail]=z.union([z.string(),z.number()]).options; tail[0].clone({coerce:true});`,
  `const items=[...z.union([z.number(),z.string()]).options]; items[0].clone({coerce:true});`,
  `const {_zod:{def:{shape:{n:child}}}}=z.object({n:z.number()}); child.clone({coerce:true});`,
  `const {def:{items:[child]}}=z.tuple([z.number()]); child.clone({coerce:true});`,
  `const {data:child}=z.any().safeParse(z.number()); child.clone({coerce:true});`,
  `const {data:{n:child}}=z.any().safeParse({n:z.number()}); child.clone({coerce:true});`,
  `const child=z.any().safeParse([z.number()]).data[0]; child.clone({coerce:true});`,
  `const [child]=z.any().safeParse([z.number()]).data; child.clone({coerce:true});`,
  `const child=z.safeParse(z.any(),z.number()).data; child.clone({coerce:true});`,
  `const {data:child}=await z.any().safeParseAsync(z.number()); child.clone({coerce:true});`,
  `z.union([z.number(),z.string()]).options.at(0).clone({coerce:true});`,
  `z.number().pipe(z.number()).def.out.clone({coerce:true});`,
  `z.array(z.number())._def.type.constructor({coerce:true});`,
  `z.object({n:z.number()})._def.shape().n.constructor({coerce:true});`,
  `z.lazy(()=>z.number()).def.getter().clone({coerce:true});`,
  `z.lazy(()=>z.number())._zod.innerType.clone({coerce:true});`,
  `z.function()._def.returns.constructor({coerce:true});`,
  `z.discriminatedUnion('k',[]).optionsMap.get('a').shape.n.constructor({coerce:true});`,
  `z.union([z.number(),z.string()]).options.slice()[0].clone({coerce:true});`,
  `z.discriminatedUnion('k',[]).optionsMap.values().next().value.clone({coerce:true});`,
  `const data=z.any().safeParse({n:z.number()}).data; data[getKey()].constructor({coerce:true});`,
  `const C=z.object({n:z.number()}).shape.n._zod.constr; new C({type:'number',coerce:true});`,
  `z.number()._zod.constr.init({}, {type:'number',coerce:true});`,
  `z.number().constructor.init({}, {type:'number',coerce:true});`,
  `let child; [child]=z.union([z.number(),z.string()]).options; child.clone({coerce:true});`,
])
  it(`F1 container propagation: ${code}`, () =>
    assert.ok(messages(code).some((m) => m.messageId === 'boundary')));

for (const code of [
  `const {data}=z.any().safeParse({n:1}); data.n;`,
  `const {data:{coerce}}=z.any().safeParse({coerce:true});`,
  `const data=z.any().safeParse({n:1}).data; data.clone({coerce:true});`,
  `const {n}=z.object({n:z.number()}).shape; export {n};`,
  `const [n]=z.union([z.number(),z.string()]).options; n.clone({coerce:false});`,
  `const {data:n}=z.any().safeParse(z.number()); n.clone({coerce:false});`,
  `const {n}=z.object({n:z.number()}).shape; n.clone({coerce:false});`,
  `z.object({}).catchall(z.number()); z.tuple([]).rest(z.number());`,
  `const schemas={a:z.object({}),b:z.number()}; schemas[owner].safeParse(data);`,
  `const schemas={a:{1:z.object({})},b:{1:z.number()}}; schemas[owner][version].parse(data);`,
  `const count=z.union([z.number(),z.string()]).options.length; use(count);`,
  `const data=z.object({n:z.number()}).parse({n:1}); data.n;`,
  `const meta=z.number().meta(); meta.clone({coerce:true});`,
])
  it(`F1 keeps containers distinct from data: ${code}`, () => assert.deepEqual(messages(code), []));

for (const write of [
  `({coerce:opts.coerce}={coerce:true});`,
  `[opts.coerce]=[true];`,
  `({coerce:opts.coerce=true}={});`,
  `[opts.coerce=true]=[];`,
  `for(opts.coerce of [true]){}`,
  `for(opts.coerce in {true:1}){}`,
  `for({coerce:opts.coerce} of [{coerce:true}]){}`,
  `for([opts.coerce] of [[true]]){}`,
  `for({x:opts.coerce=true} of [{}]){}`,
  `for([opts.coerce] in {true:1}){}`,
  `({opts}={opts:{coerce:true}});`,
  `[opts]=[{coerce:true}];`,
  `({opts={coerce:true}}={});`,
  `for(opts of [{coerce:true}]){}`,
  `opts.__proto__={coerce:true};`,
])
  it(`F2 write target: ${write}`, () =>
    assert.ok(messages(`let opts={}; ${write} z.number(opts);`).length));
for (const write of [
  `allowed={includes:Number};`,
  `allowed.includes=Number;`,
  `allowed.includes=v=>Number(v);`,
  `({includes:allowed.includes}={includes:Number});`,
  `for(allowed.includes of [Number]){}`,
  `const alias=allowed; alias.includes=Number;`,
  `Object.assign(allowed,{includes:Number});`,
  `const alias=allowed; mutate(alias);`,
])
  it(`F2 mutable helper: ${write}`, () =>
    assert.ok(
      messages(`let allowed=[]; ${write} z.preprocess(v=>allowed.includes(v),z.number());`).length,
    ));
for (const pattern of ['{opts}', '{opts={coerce:true}}', '[opts={coerce:true}]'])
  it(`F2 binding pattern: ${pattern}`, () =>
    assert.ok(messages(`const ${pattern}={}; z.number(opts);`).length));
it('F2 immutable array helper', () =>
  assert.deepEqual(
    messages(`const allowed=[]; z.preprocess(v=>allowed.includes(v),z.boolean());`),
    [],
  ));

for (const code of [
  `let n; ({n=z.number()}={}); n.clone({coerce:true});`,
  `let n; [n=z.number()]=[]; n.clone({coerce:true});`,
  `const {n=z.number()}={}; n.clone({coerce:true});`,
  `const [n=z.number()]=[]; n.clone({coerce:true});`,
  `let f; [f]=[z.number]; f({coerce:true});`,
  `let f; ({f=z.number}={}); f({coerce:true});`,
  `let n; for(n of [z.number()]){} n.clone({coerce:true});`,
  `for(const n of [z.number()]){n.clone({coerce:true});}`,
  `for(const [n] of [[z.number()]]){n.clone({coerce:true});}`,
  `for(const {n=z.number()} of [{}]){n.clone({coerce:true});}`,
  `let n; for({n} of [{n:z.number()}]){} n.clone({coerce:true});`,
  `for(const n of z.union([z.number(),z.string()]).options){n.clone({coerce:true});}`,
  `const allowed=[]; allowed.reverse=Number; z.preprocess(v=>allowed.reverse(v),z.number());`,
])
  it(`F2 binding provenance: ${code}`, () =>
    assert.ok(messages(code).some((m) => m.ruleId === 'boundary/coercion')));

for (const code of [
  `let n=z.number(); n.clone({coerce:true}); n={x:z.number()};`,
  `let n=z.number(); n={x:z.number()}; n.x.clone({coerce:true});`,
  `let n={x:z.number()}; n=z.number(); n.clone({coerce:true});`,
  `const allowed=/x/; allowed.test=Number; z.preprocess(v=>allowed.test(v),z.number());`,
  `const allowed=new Date(); allowed.getTime=Number; z.preprocess(v=>allowed.getTime(v),z.number());`,
])
  it(`F2 safety alternatives: ${code}`, () =>
    assert.ok(messages(code).some((m) => m.ruleId === 'boundary/coercion')));

for (const code of [
  `const cases=[[z.number(),true],[z.string(),3]];for(const [schema,input] of cases){schema.safeParse(input,{reportInput:true});}`,
  `z.string().transform(v=>{const at=new Date(v);if(Number.isNaN(at.getTime()))return undefined;return at;});`,
])
  it(`F2 preserves local proofs: ${code}`, () => assert.deepEqual(messages(code), []));
it('F2 refuses a returned receiver reused across callbacks', () =>
  assert.ok(
    messages(`const at=new Date();z.preprocess(v=>{at.getTime(v);return at;},z.number());`).length,
  ));

for (const code of [
  `const allowed=[]; allowed.includes=Number; const alias=allowed; z.preprocess(v=>alias.includes(v),z.number());`,
  `const allowed=[]; allowed.includes=Number; const has=(a,x)=>a.includes(x); z.preprocess(v=>has(allowed,v),z.number());`,
  `const allowed=[]; allowed.includes=Number; const alias=allowed; const next=alias; z.preprocess(v=>next.includes(v),z.number());`,
])
  it(`F2 includes receiver provenance: ${code}`, () =>
    assert.ok(
      messages(code).some(
        ({ ruleId, messageId }) => ruleId === 'boundary/coercion' && messageId === 'preprocess',
      ),
    ));

for (const slot of [
  ...['number', ...formats].map((name) => (value) => `z.${name}(${value});`),
  (value) => `z.int(${value});`,
  (value) => `z.number().clone(${value});`,
  (value) => `z.clone(z.number(),${value});`,
  (value) => `z.core._int(z.ZodNumberFormat,${value});`,
  (value) => `z.hash('sha256',${value});`,
  (value) => `z.stringFormat('custom',/x/,${value});`,
  (value) => `z.core._hash(z.ZodCustomStringFormat,'sha256',${value});`,
  (value) => `z.core._stringFormat(z.ZodCustomStringFormat,'custom',/x/,${value});`,
  (value) => `z.ZodNumber.create(${value});`,
  (value) => `z.string(${value}).transform(Number);`,
])
  for (const value of [
    'undefined',
    'void 0',
    'void false',
    'absence',
    'alias',
    '{...undefined}',
    '{...absence}',
    '{...void 0}',
  ])
    it(`F4 optional absence: ${slot(value)}`, () =>
      assert.deepEqual(
        messages(`const absence=undefined; const alias=absence; ${slot(value)}`),
        [],
      ));
for (const code of [
  `for(const options of [{coerce:true}]){z.number(options);}`,
  `for(const options of [{coerce:true}]){const absence=options;z.number().clone(absence);}`,
  `const undefined={}; z.number(undefined);`,
  `const undefined=void 0; z.number(undefined);`,
  `const undefined=void 0; const absence=undefined; z.number({...absence});`,
  `function f(undefined){z.number(undefined);}`,
  `const undefined={coerce:true}; z.int(undefined);`,
  `function f(undefined){const absence=undefined; z.number().clone(absence);}`,
  `function f(undefined){z.number({...undefined});}`,
  `let absence=undefined; absence={coerce:true}; z.number(absence);`,
])
  it(`F4 shadowed or mutable absence: ${code}`, () => assert.ok(messages(code).length));

for (const expression of [
  'z.number(undefined)',
  'z.int(undefined)',
  'z.number(void 0)',
  'z.number().clone(undefined)',
  'z.number(absence)',
  'z.number({...undefined})',
])
  it(`F4 executable absence: ${expression}`, () => {
    assert.deepEqual(messages(`const absence=undefined; ${expression};`), []);
    const result = runInNewContext(
      `const absence=undefined; const s=${expression}; [s.parse(42),s.safeParse(true).success];`,
      { z: contractsRequire('zod') },
    );
    assert.equal(result[0], 42);
    assert.equal(result[1], false);
  });

// FU-070: callback input proofs follow the actual API argument signature.
for (const code of [
  `z.string().pipe(z.transform(Number));`,
  `z.pipe(z.string(), z.transform(Number));`,
  `z.string().trim().pipe((z.transform(v => Number(v))));`,
  `z.pipe(z.string(), z.pipe(z.string(), z.transform(Number)));`,
  `z.string().transform(v => v.replace(/x/g, s => s.toUpperCase()));`,
  `z.string().transform(v => v.replace(/x/g, s => Number(s)));`,
  `z.string().transform(v => v.replace('x', s => s.toUpperCase()));`,
  `z.ZodEffects.create(z.string(), {type:'transform', transform:v=>v.trim()});`,
  `z.ZodEffects.create(z.string(), {type:'transform', transform:Number});`,
  `new z.ZodEffects({schema:z.string(),effect:{type:'transform',transform:Number}});`,
])
  it(`FU-070 valid callback: ${code}`, () => assert.deepEqual(messages(code), []));
for (const code of [
  `z.unknown().pipe(z.transform(Number));`,
  `z.pipe(z.unknown(), z.transform(Number));`,
  `const t=z.transform(Number); z.string().pipe(t); z.unknown().pipe(t);`,
  `z.string().transform(v => v.replace(/x/g, (s, offset) => Number(offset)));`,
  `z.unknown().transform(v => v.replace(/x/g, s => Number(s)));`,
  `z.string().transform(v => v.replace({[Symbol.replace]:(s,fn)=>fn(true)}, Number));`,
  `z.string().transform(v => v.replace(pattern, Number));`,
  `z.ZodEffects.create(z.unknown(), {type:'transform', transform:Number});`,
  `z.ZodEffects.create(z.string(), {type:'preprocess', transform:Number});`,
])
  it(`FU-070 refuses unproven input: ${code}`, () => assert.ok(messages(code).length, code));

// FU-069a: infer each binding, then discard element proofs across mutation.
const unsoundBindings = [
  `const [x=true]=v; return Number(x)`,
  `const [ok, x=true]=v; return Number(x)`,
  `const [...xs]=v; return Number(xs)`,
  `v[0]=true; const [x]=v; return Number(x)`,
  `const alias=v; alias[0]=true; const [x]=v; return Number(x)`,
  `const alias=v.reverse(); alias[0]=true; return v.map(Number)`,
  `return v.map((s,i,a)=>{a[1]=true; return Number(s)})`,
  `return v.map((s,...args)=>{args[1][1]=true; return Number(s)})`,
  `return v.map(function(s){arguments[2][1]=true; return Number(s)})`,
  `const {length:n}=v;return Number(n)`,
  `return v.map((s,i,a)=>{const alias=a;alias[1]=true; return Number(s)})`,
  `return v.filter((s,i,a)=>{a[1]=true; return true}).map(Number)`,
  `const f=(s,i,a)=>{a[1]=true;return Number(s)};const alias=f;return v.map(alias)`,
];
for (const body of unsoundBindings)
  for (const code of [
    `z.array(z.string()).transform(v=>{${body}});`,
    `z.array(z.string()).overwrite(v=>{${body}});`,
    `z.codec(z.array(z.string()),z.unknown(),{decode:v=>{${body}},encode:v=>v});`,
    `z.codec(z.unknown(),z.array(z.string()),{decode:v=>v,encode:v=>{${body}}});`,
  ])
    it(`FU-069a refuses unsound proof: ${code}`, () => assert.ok(messages(code).length, code));
for (const code of [
  `z.string().transform(v=>{const [...xs]=v.split(',');return Number(xs)});`,
  `z.string().transform(v=>{const [x=true]=v.split(',');return Number(x)});`,
])
  it(`FU-069a split binding refuses: ${code}`, () => assert.ok(messages(code).length, code));
for (const body of [
  `const [x='4']=v; return Number(x)`,
  `const [x,y='5']=v; return Number(y)`,
  `const [...xs]=v; return xs.map(Number)`,
  `return v.map((s,i,a)=>Number(s))`,
  `return v.filter(s=>s.length>0).map(Number)`,
])
  it(`FU-069a preserves stable strings: ${body}`, () =>
    assert.deepEqual(messages(`z.array(z.string()).transform(v=>{${body}});`), []));

// FU-069b: alternate resolved files never inherit a reviewed source's hash.
for (const ext of ['mjs', 'cjs', 'tsx', 'jsx', 'mts', 'cts'])
  it(`FU-069b refuses unregistered ${ext} import`, () =>
    assert.ok(
      messages(
        `import {isOrderCommand} from '@/lib/order-fields.${ext}'; z.transform(isOrderCommand);`,
      ).length,
    ));
it('FU-069b resolves exact sources and dependency siblings', () => {
  const root = mkdtempSync(join(tmpdir(), 'rasta-zod-resolution-'));
  const path = 'apps/web/src/lib/order-fields';
  try {
    cpSync(join(ROOT, path + '.ts'), join(root, path + '.ts'));
    for (const spelling of [path, path + '.ts', path + '.js'])
      assert.equal(verifiedCallbackHelper(root, spelling, 'isOrderCommand'), 'predicate');
    for (const ext of ['mjs', 'cjs', 'tsx', 'jsx', 'mts', 'cts', 'js']) {
      appendFileSync(join(root, path + '.' + ext), 'export const isOrderCommand=Number;');
      assert.equal(verifiedCallbackHelper(root, path + '.' + ext, 'isOrderCommand'), undefined);
      assert.equal(verifiedCallbackHelper(root, path, 'isOrderCommand'), undefined);
      rmSync(join(root, path + '.' + ext));
    }
    cpSync(join(ROOT, 'apps/web/src/lib/format'), join(root, 'apps/web/src/lib/format'), {
      recursive: true,
    });
    cpSync(
      join(ROOT, 'apps/web/src/lib/form-issues.ts'),
      join(root, 'apps/web/src/lib/form-issues.ts'),
    );
    assert.equal(
      verifiedCallbackHelper(root, 'apps/web/src/lib/format', 'toLatinDigits'),
      'string',
    );
    for (const shadow of ['apps/web/src/lib/format.ts', 'apps/web/src/lib/format/digits.tsx']) {
      appendFileSync(join(root, shadow), 'export const toLatinDigits=Number;');
      assert.equal(
        verifiedCallbackHelper(root, 'apps/web/src/lib/format', 'toLatinDigits'),
        undefined,
      );
      rmSync(join(root, shadow));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('FU-069b respects compiler aliases and module suffixes', () => {
  const root = mkdtempSync(join(tmpdir(), 'rasta-zod-config-'));
  const source = 'apps/web/src/lib/order-fields.ts',
    importer = join(root, 'apps/web/src/probe.ts');
  const config = join(root, 'apps/web/tsconfig.json');
  const paths = { '@/*': ['./src/*'] };
  const options = { module: 'esnext', moduleResolution: 'bundler', baseUrl: '.', paths };
  const configure = (extra) =>
    writeFileSync(
      config,
      JSON.stringify({ compilerOptions: { ...options, ...extra }, include: ['src/**/*'] }),
    );
  const proof = () =>
    verifiedCallbackHelper(root, '@/lib/order-fields', 'isOrderCommand', { importer });
  try {
    cpSync(join(ROOT, source), join(root, source));
    configure({});
    assert.equal(proof(), 'predicate');
    cpSync(join(ROOT, source), join(root, 'apps/web/src/alternate/order-fields.ts'));
    configure({ paths: { '@/lib/*': ['./src/alternate/*'] } });
    assert.equal(proof(), undefined);
    appendFileSync(
      join(root, 'apps/web/src/lib/order-fields.evil.ts'),
      'export const isOrderCommand=Number;',
    );
    configure({ moduleSuffixes: ['.evil', ''] });
    assert.equal(proof(), undefined);
    cpSync(join(ROOT, 'apps/web/src/lib/format'), join(root, 'apps/web/src/lib/format'), {
      recursive: true,
    });
    cpSync(
      join(ROOT, 'apps/web/src/lib/form-issues.ts'),
      join(root, 'apps/web/src/lib/form-issues.ts'),
    );
    appendFileSync(
      join(root, 'apps/web/src/lib/format/digits.evil.ts'),
      'export const toLatinDigits=Number;',
    );
    assert.equal(
      verifiedCallbackHelper(root, '@/lib/format', 'toLatinDigits', { importer }),
      undefined,
    );
    writeFileSync(config, '{');
    assert.equal(proof(), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// FU-068 direct APIs: namespace slots and executable constructor definitions.
for (const code of [
  `z.effect(z.unknown(),{type:'transform',transform:Number});`,
  `z.transformer(z.unknown(),{type:'preprocess',transform:Number});`,
  `z.transformer(z.unknown(),{type:'transform',transform:(v,ctx,n=Number(v))=>n});`,
  `z.refine(v=>{v.n=Number(v.n);return true});`,
  `z.superRefine((v,ctx,n=Number(v))=>{});`,
  `z.check(p=>{p.value=Number(p.value)});`,
  `z.custom(v=>{v.n=Number(v.n);return true});`,
  `new z.ZodCustom({type:'custom',fn:Number});`,
  `z.ZodCustom.init({}, {type:'custom',fn:Number});`,
  `new z.ZodEffects({schema:z.unknown(),effect:{type:'refinement',refinement:Number}});`,
  `new z.core.$ZodCheckOverwrite({check:'overwrite',tx:v=>v,when:p=>{p.value=Number(p.value);return false}});`,
  `new z.core.$ZodCheckMinLength({minimum:0,when:p=>{p.value=Number(p.value);return false}});`,
  `z.refine(()=>true,{when:(p,n=Number(p.value))=>true});`,
  `z.core._refine(z.ZodCustom,Number);`,
  `z.core._custom(z.ZodCustom,Number);`,
  `z.core._superRefine((v,ctx,n=Number(v))=>{});`,
  `z.core._check(p=>{p.value=Number(p.value)});`,
  `z.effect(z.string(),{type:'preprocess',transform:v=>typeof v==='string'?Number(v):v});`,
  `z.ZodEffects.createWithPreprocess(v=>typeof v==='string'?Number(v):v,z.number());`,
])
  it(`FU-068 direct callback refuses: ${code}`, () => assert.ok(messages(code).length, code));
for (const code of [
  `z.custom();`,
  `z.custom(v=>typeof v==='string');`,
  `z.superRefine((v,ctx)=>ctx.addIssue({code:'custom'}));`,
  `z.effect(z.string(),{type:'transform',transform:Number});`,
  `z.ZodEffects.create(z.string(),{type:'refinement',refinement:Number});`,
  `z.effect(z.unknown(),{type:'preprocess',transform:v=>typeof v==='string'?v.trim():v});`,
])
  it(`FU-068 direct callback preserves: ${code}`, () => assert.deepEqual(messages(code), []));

for (const [module, code] of [
  ['zod/v3', `z.effect(z.unknown(),{type:'transform',transform:Number});`],
  ['zod/v3', `z.transformer(z.unknown(),{type:'preprocess',transform:Number});`],
  ['zod/mini', `z.custom(Number);`],
  ['zod/mini', `z.check(p=>{p.value=Number(p.value)});`],
  ['zod/v4/core', `z._refine(z.$ZodCustom,Number);`],
])
  it(`FU-068 module callback refuses: ${module} ${code}`, () =>
    assert.ok(messages(code, module).length, code));
it('FU-068 optional when shares the absence proof', () => {
  assert.deepEqual(
    messages(`new z.core.$ZodCheckOverwrite({check:'overwrite',tx:v=>v,when:undefined});`),
    [],
  );
  assert.ok(
    messages(
      `function f(undefined){new z.core.$ZodCheckOverwrite({check:'overwrite',tx:v=>v,when:undefined});}`,
    ).length,
  );
});

// PR #730 r1 F1: only a receiverless callback takes the pipe's upstream as its
// input; a method-form callback's input is its own receiver chain.
for (const code of [
  `z.unknown().pipe(z.string().transform(v => v.trim()));`,
  `z.unknown().pipe(z.string().overwrite(v => v.trim()));`,
  `z.pipe(z.unknown(), z.string().transform(Number));`,
  `z.string().pipe(z.string().transform(Number));`,
])
  it(`r1 F1 method callback uses its receiver: ${code}`, () =>
    assert.deepEqual(messages(code), []));
for (const code of [
  `z.string().pipe(z.string().transform(s => s.split(',')).transform(Number));`,
  `z.string().pipe(z.string().transform(s => s.split(',')).overwrite(Number));`,
  `z.string().pipe(z.preprocess(v => v, z.any()).transform(Number));`,
  `z.pipe(z.string(), z.string().transform(s => s.split(',')).transform(Number));`,
  `z.string().pipe(z.unknown().transform(Number));`,
  `z.string().pipe((z.unknown().transform(Number)));`,
])
  it(`r1 F1 pipe never stands in for a receiver: ${code}`, () =>
    assert.ok(messages(code).length, code));

// PR #730 r1 F2: JavaScript keeps the last duplicate key, so a definition
// field named twice is refused instead of read first-match.
for (const code of [
  `z.ZodEffects.create(z.string(), {type:'transform', transform:Number, type:'preprocess'});`,
  `z.ZodEffects.create(z.string(), {type:'refinement', refinement:Number, type:'preprocess'});`,
  `z.ZodEffects.create(z.string(), {type:'transform', transform:v=>v.trim(), 'type':'transform'});`,
  `new z.ZodEffects({schema:z.string(), effect:{type:'transform',transform:Number}, schema:z.unknown()});`,
  `new z.ZodCodec({type:'pipe',in:z.string(),out:z.number(),transform:Number,reverseTransform:v=>v,in:z.unknown()});`,
  `new z.ZodCodec({type:'pipe',in:z.number(),out:z.string(),out:z.unknown(),transform:v=>v,reverseTransform:Number});`,
])
  it(`r1 F2 duplicate definition key refuses: ${code}`, () =>
    assert.ok(
      messages(code).some((m) => m.messageId === 'preprocess'),
      JSON.stringify(messages(code)),
    ));
