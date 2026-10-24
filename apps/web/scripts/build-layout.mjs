// What `next build` will really do, read with Next's own config loader instead of
// guessed from the tokens of `next.config.mjs` (an imported settings module, a spread,
// a computed key or an environment variable can all move the build output).
//
// The check after the build reads `.next/server/server-reference-manifest.json`. That is
// the manifest of THIS build only while the effective configuration says the build
// writes to `.next`, from a clean `.next`, with the default tsconfig; anything else is
// refused rather than followed.
//
// Loader and environment, both from the installed Next (15.5.28):
//   next/dist/server/config.js: `loadConfig(phase, dir, { silent = true })` (default export)
//     reads next.config.mjs, applies defaults and the user's function form, and returns
//     the effective config. `silent` makes its warning logger a no-op (`curLog`).
//   next/dist/bin/next: `process.env.NODE_ENV = process.env.NODE_ENV || defaultEnv`
//     (`production` for every command but `dev`), set before the command runs.
//   next/dist/build/index.js: `loadEnvConfig(dir, false, ...)` is what `next build` does for
//     .env files; `loadConfig` calls it too (config.js, `loadEnvConfig(dir, phase === PHASE_DEVELOPMENT_SERVER)`).
//   next/dist/build/index.js:527: `if (config.cleanDistDir ...) recursiveDelete(distDir, /^cache/)`:
//     the build empties distDir first, which is why a receipt written by the build cannot
//     survive a build that fails.
//
// Nothing here prints a config value, and an exception's message is never shown (Next
// quotes config text in errors): a diagnostic is a fixed sentence plus the key name.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'];

/**
 * @param {string} projectDir  the web project (where next.config.mjs is)
 * @param {{ nextFrom?: string, env?: Record<string, string | undefined> }} [options]
 *   `nextFrom`: where to resolve `next` from (default: the project itself).
 * @returns {Promise<{ loaded: true, distDir: unknown, tsconfigPath: unknown, cleanDistDir: unknown } | { loaded: false }>}
 */
export async function effectiveBuildLayout(projectDir, options = {}) {
  const nextFrom = options.nextFrom ?? projectDir;
  const saved = {};
  for (const method of CONSOLE_METHODS) {
    saved[method] = console[method];
    console[method] = () => {};
  }
  const touched = options.env ? Object.keys(options.env) : [];
  const before = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  try {
    for (const key of touched) {
      if (options.env[key] === undefined) delete process.env[key];
      else process.env[key] = options.env[key];
    }
    // The same default `next build` runs under (bin/next).
    process.env.NODE_ENV = process.env.NODE_ENV || 'production';
    const require = createRequire(join(nextFrom, 'package.json'));
    const loadConfig = require('next/dist/server/config.js').default;
    const { PHASE_PRODUCTION_BUILD } = require('next/dist/shared/lib/constants.js');
    const config = await loadConfig(PHASE_PRODUCTION_BUILD, projectDir, { silent: true });
    return {
      loaded: true,
      distDir: config.distDir,
      tsconfigPath: config.typescript?.tsconfigPath,
      cleanDistDir: config.cleanDistDir,
    };
  } catch {
    return { loaded: false };
  } finally {
    for (const method of CONSOLE_METHODS) console[method] = saved[method];
    for (const key of touched) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

/** Fixed sentences naming the offending key; empty when the layout is the supported one. */
export function layoutProblems(layout) {
  if (!layout.loaded) {
    return ['next config: could not be loaded (details withheld); refusing'];
  }
  const problems = [];
  if (layout.distDir !== '.next') {
    problems.push('distDir: effective value is not ".next"; only the default output is checked');
  }
  if (layout.tsconfigPath !== undefined && layout.tsconfigPath !== 'tsconfig.json') {
    problems.push('typescript.tsconfigPath: effective value is not the default; refusing');
  }
  if (layout.cleanDistDir !== true) {
    problems.push('cleanDistDir: effective value is not true; the build would keep old artifacts');
  }
  return problems;
}
