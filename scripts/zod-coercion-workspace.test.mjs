import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ESLint } from 'eslint';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const RULE = 'zod/coercion-boundary';
const EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];

// Separate processes: typescript-eslint cannot share two config roots in one process.
if (process.argv[2] === '--lint') {
  const { cwd, config, probes } = JSON.parse(readFileSync(0, 'utf8'));
  const eslint = new ESLint({ cwd, overrideConfigFile: config });
  const results = [];
  for (const { filePath, code } of probes) {
    const [result] = await eslint.lintText(code, { filePath });
    results.push(result.messages.filter(({ ruleId, fatal }) => ruleId === RULE || fatal));
  }
  process.stdout.write(JSON.stringify(results));
  process.exit(0);
}

for (const config of ['eslint.config.mjs', 'apps/web/eslint.config.mjs']) {
  for (const workspace of ['.', 'apps/web']) {
    test(`${config}, cwd=${workspace}: all six extensions enforce the boundary and exact exemptions`, () => {
      const probes = [];
      const expected = [];
      for (const ext of EXTENSIONS) {
        const filePath = join(ROOT, `apps/web/src/coercion-probe.${ext}`);
        const jsx = ['jsx', 'tsx'].includes(ext) ? 'const element = <div />;' : '';
        const prelude =
          ext === 'cjs'
            ? "const { z: schema } = require('zod');"
            : "import { z as schema } from 'zod';";
        for (const [code, count] of [
          [`${prelude} schema['coerce'].number(); ${jsx}`, 1],
          [`${prelude} schema.number({ coerce: true }); ${jsx}`, 1],
          [`${prelude} schema.preprocess(v => BigInt(v), schema.bigint()); ${jsx}`, 1],
          [`${prelude} schema.number(); ${jsx}`, 0],
          [`${prelude} schema.unknown().transform(Number); ${jsx}`, 1],
          [`${prelude} schema.transform(Number); ${jsx}`, 1],
          [`${prelude} const f=async v=>Number(v); schema.unknown().transform(f); ${jsx}`, 1],
          [`${prelude} schema.unknown().pipe(schema.transform(Number)); ${jsx}`, 1],
          [`${prelude} new schema.ZodTransform({type:'transform',transform:Number}); ${jsx}`, 1],
          [`${prelude} schema.unknown().overwrite(Number); ${jsx}`, 1],
          [
            `${prelude} schema.codec(schema.unknown(),schema.number(),{decode:Number,encode:v=>v}); ${jsx}`,
            1,
          ],
          [
            `${prelude} schema.codec(schema.number(),schema.unknown(),{decode:v=>v,encode:Number}); ${jsx}`,
            1,
          ],
          [`${prelude} schema.unknown().transform((v,n=Number(v))=>n); ${jsx}`, 1],
          [`${prelude} schema.int(getOptions()); ${jsx}`, 1],
          [`${prelude} schema.number().clone(getOptions()); ${jsx}`, 1],
          [
            `${prelude} schema.preprocess((v, ctx, n = Number(v)) => n, schema.number()); ${jsx}`,
            1,
          ],
          [`${prelude} schema.object({coerce: schema.boolean()}); ${jsx}`, 0],
          [`${prelude} schema.safeParse(schema.object({}), {coerce: true}); ${jsx}`, 0],
        ]) {
          probes.push({ filePath, code });
          expected.push(count);
        }
      }
      const code = "import { z } from 'zod'; z.coerce.number();";
      for (const [file, count] of [
        ['apps/web/src/server/env.ts', 0],
        ['apps/web/src/other/env.ts', 1],
        ['apps/web/src/other/env-issues.spec.ts', 1],
      ]) {
        probes.push({ filePath: join(ROOT, file), code });
        expected.push(count);
      }
      const results = JSON.parse(
        execFileSync(process.execPath, [SELF, '--lint'], {
          cwd: join(ROOT, workspace),
          input: JSON.stringify({ cwd: join(ROOT, workspace), config: join(ROOT, config), probes }),
          encoding: 'utf8',
        }),
      );
      results.forEach((messages, index) => {
        assert.ok(
          !messages.some(({ fatal }) => fatal),
          JSON.stringify({ probe: probes[index], messages }),
        );
        assert.equal(
          messages.filter(({ ruleId, severity }) => ruleId === RULE && severity === 2).length,
          expected[index],
          JSON.stringify({ probe: probes[index], messages }),
        );
      });
    });
  }
}
