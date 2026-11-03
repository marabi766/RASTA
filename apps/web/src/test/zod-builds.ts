import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

/**
 * Runs an export of a test module under one build of the installed (patched)
 * zod — its CommonJS or its ES module entry — in a child process, so a spec
 * judges both builds a bundle may load, not only the one Jest resolves. The
 * workspace packages the module imports (`@rasta/contracts`) load as they do
 * here, and their `zod` is the chosen build too.
 */

export type ZodBuild = 'cjs' | 'esm';
export const ZOD_BUILDS: readonly ZodBuild[] = ['cjs', 'esm'];

function zodEntry(build: ZodBuild): string {
  const dir = dirname(require.resolve('zod/package.json', { paths: [__dirname] }));
  return join(dir, build === 'cjs' ? 'index.cjs' : 'index.js');
}

/**
 * The child, whole, on stdin (`node -`), with what it runs inlined as JSON:
 * it reads no command line and no environment (scripts/cli-contract.mjs).
 */
const CHILD = `
const fs = require('node:fs');
const Module = require('node:module');
const { swc: swcPath, zod: zodEntry, module: file, name, args } = PAYLOAD;
const swc = require(swcPath);
for (const extension of ['.ts', '.tsx']) {
  require.extensions[extension] = (mod, filename) =>
    mod._compile(
      swc.transformSync(fs.readFileSync(filename, 'utf8'), {
        filename,
        jsc: { parser: { syntax: 'typescript', tsx: extension === '.tsx' }, target: 'es2022' },
        module: { type: 'commonjs' },
      }).code,
      filename,
    );
}
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'zod' ? zodEntry : resolve.call(this, request, ...rest);
};
Promise.resolve(require(file)[name](args))
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch((error) => { console.error(error); process.exit(1); });
`;

/** `module`'s export `name`, called with `args` under `build`; its JSON result. */
export function runInZodBuild<T>(
  build: ZodBuild,
  module: string,
  name: string,
  args: unknown = {},
): T {
  const payload = {
    swc: require.resolve('@swc/core', { paths: [__dirname] }),
    zod: zodEntry(build),
    module,
    name,
    args,
  };
  const out = execFileSync(process.execPath, ['-'], {
    cwd: __dirname,
    input: `const PAYLOAD = ${JSON.stringify(payload)};\n${CHILD}`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return JSON.parse(out) as T;
}
