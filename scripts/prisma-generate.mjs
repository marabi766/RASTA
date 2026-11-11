// Retry at the individual generator boundary, never the whole Turbo task graph.
import { spawnSync } from 'node:child_process';
import { resolve, relative } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const BACKOFF_MS = [2000, 5000]; // Three attempts total; no unbounded retry knob.
// Match the thrown download error, never arbitrary words inside a config diagnostic.
function transientDownload(stderr = '') {
  const lines = stderr.split(/\r?\n/);
  const thrown = lines.find((line) => /^(?:Error|TypeError): /.test(line));
  if (!thrown) return false;
  if (thrown === 'Error: aborted')
    return lines.some((line) => /^\s+at TLSSocket\.socketCloseListener\b/.test(line));
  return /^(?:Error|TypeError): (?:request to|fetch failed for) https:\/\/binaries\.prisma\.sh\/[^\s]+ failed, reason: (?:read ECONNRESET|connect ETIMEDOUT|socket hang up|fetch failed)$/.test(
    thrown,
  );
}

// Only the rollback integration test needs a non-default schema. Refuse arbitrary
// schemas/flags, outside paths and symlinks; default generation retains Prisma's cwd.
export function schemaArgs(argv, cwd = process.cwd()) {
  if (argv.length === 0) return [];
  const service = fileURLToPath(new URL('../services/economic-service/', import.meta.url));
  if (argv.length !== 2 || argv[0] !== '--schema' || resolve(cwd) !== resolve(service))
    throw new Error('unsupported generation arguments');
  const schema = resolve(cwd, argv[1]);
  if (
    !/^node_modules\/\.cache\/settlement-rollback-[A-Za-z0-9]+\/prisma\/schema\.prisma$/.test(
      relative(cwd, schema),
    ) ||
    realpathSync(schema) !== schema
  )
    throw new Error('unsupported generation schema');
  return ['--schema', schema];
}

export async function generate({
  args = [],
  run = () => {
    return spawnSync(
      process.execPath,
      [resolve('node_modules/prisma/build/index.js'), 'generate', ...args],
      {
        stdio: ['inherit', 'inherit', 'pipe'],
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  },
  sleep = setTimeout,
  log = (message) => process.stderr.write(message),
} = {}) {
  for (let attempt = 0; ; attempt++) {
    const result = run();
    if (result.stderr) log(result.stderr);
    if (result.status === 0 && !result.error && !result.signal) return 0;
    // Launch failures, signals, timeouts and unknown errors fail closed.
    if (
      result.error ||
      result.signal ||
      !Number.isInteger(result.status) ||
      !transientDownload(result.stderr) ||
      attempt === BACKOFF_MS.length
    )
      return result.status > 0 ? result.status : 1;
    log(
      `[prisma-generate] transient network error; retry ${attempt + 2}/3 in ${BACKOFF_MS[attempt]}ms\n`,
    );
    await sleep(BACKOFF_MS[attempt]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await generate({ args: schemaArgs(process.argv.slice(2)) });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
