// Retry at the individual generator boundary, never the whole Turbo task graph.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const BACKOFF_MS = [2000, 5000]; // Three attempts total; no unbounded retry knob.
const NETWORK_ERROR =
  /\b(?:ECONNRESET|ETIMEDOUT)\b|\bError:\s*aborted\b|\bsocket hang up\b|\bfetch failed\b/i;

export async function generate({
  run = () => {
    return spawnSync(
      process.execPath,
      [resolve('node_modules/prisma/build/index.js'), 'generate'],
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
      /\bP\d{4}\b|schema validation|error validating/i.test(result.stderr ?? '') ||
      !NETWORK_ERROR.test(result.stderr ?? '') ||
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
    if (process.argv.length !== 2) throw new Error('prisma-generate accepts no arguments');
    process.exitCode = await generate();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
