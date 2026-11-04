/**
 * Records, after this run's `next build` and before its `next start`, which run
 * built the production build on disk: `{ runId, buildId }` in a file keyed by
 * this worktree and port. `playwright.config.ts` reads it back to prove a
 * listener on the port is the server this run started (`server-reuse.ts`).
 *
 *     WEB_E2E_RUN_ID=<id> node e2e/record-server-run.mjs <port>
 *
 * Refuses (exit 1) without a run id or a build: a marker it cannot stand behind
 * is a marker that must not exist.
 */
/* global process */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]);
const runId = process.env.WEB_E2E_RUN_ID ?? '';

if (!Number.isInteger(port)) {
  process.stderr.write('record-server-run: needs a port argument\n');
  process.exit(1);
}

// Same key as `runMarkerFile` in server-reuse.ts (the spec pins the two together).
const key = createHash('sha256').update(webDir).digest('hex').slice(0, 16);
const file = join(tmpdir(), `rasta-web-e2e-run-${key}-${port}.json`);
// Whatever an earlier run left is gone before anything else can fail.
rmSync(file, { force: true });

if (runId === '') {
  process.stderr.write('record-server-run: needs WEB_E2E_RUN_ID\n');
  process.exit(1);
}

let buildId = '';
try {
  buildId = readFileSync(join(webDir, '.next', 'BUILD_ID'), 'utf8').trim();
} catch {
  buildId = '';
}
if (buildId === '') {
  process.stderr.write(
    'record-server-run: .next/BUILD_ID is missing or empty; no build to record\n',
  );
  process.exit(1);
}

mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify({ runId, buildId })}\n`, { mode: 0o600 });
