#!/usr/bin/env node
/**
 * Copies a service's generated Prisma client from `src/generated` into
 * `dist/generated`.
 *
 * Why this is needed:
 *
 *   `schema.prisma` generates into `src/generated/prisma`, and source files
 *   import it as `../generated/prisma`. That relative path is correct in
 *   `src/`, and it is still correct *after* compilation — but relative to
 *   `dist/`, where nothing was ever generated. So a compiled service builds
 *   cleanly and then dies at startup with
 *   `Cannot find module '../generated/prisma'`.
 *
 *   The generated client is already JavaScript, so tsc neither compiles nor
 *   emits it; it has to be placed alongside the compiled output explicitly.
 *
 * Run from a service directory as the last step of `build`.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const cwd = process.cwd();
const source = resolve(cwd, 'src/generated');
const target = resolve(cwd, 'dist/generated');

if (!existsSync(source)) {
  console.error(
    `[copy-prisma-client] No generated client at ${source}.\n` +
      'Run `prisma generate` before building.',
  );
  process.exit(1);
}

mkdirSync(resolve(cwd, 'dist'), { recursive: true });
cpSync(source, target, { recursive: true });

console.warn(`[copy-prisma-client] ${source} -> ${target}`);
