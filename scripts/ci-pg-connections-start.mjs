#!/usr/bin/env node
/** Bounded ownership handshake with the same teardown on errors and interruption. */
import { spawn } from 'node:child_process';
import { closeSync, openSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  captureProcess,
  checkedSignal,
  errorCode,
  readOwner,
  requestStop,
  TIMING,
  WATCHER_COMMAND,
} from './ci-pg-connections-lib.mjs';

const file = process.env.PG_CONNECTIONS_OWNER;
let child;
let owner;
let log;
let exited = false;
let interrupted = false;
let teardown;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function stop() {
  teardown ??= (async () => {
    requestStop(file);
    if (child?.pid && !exited) {
      checkedSignal(owner, 'SIGTERM');
      await delay(500);
      if (!exited) checkedSignal(owner, 'SIGKILL', { group: true });
      const deadline = Date.now() + TIMING.killWaitMs;
      while (!exited && Date.now() < deadline) await delay(25);
      child.unref();
    }
  })();
  return teardown;
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    interrupted = true;
    void stop();
  });
}
try {
  rmSync(file, { force: true });
  rmSync(`${file}.stop`, { force: true });
  log = openSync(`${file}.log`, 'w', 0o600);
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./ci-pg-connections-watch.mjs', import.meta.url))],
    {
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...process.env,
        PG_CONNECTIONS_DEADLINE: String(Date.now() + TIMING.watcherLifetimeMs),
      },
    },
  );
  owner = captureProcess(child.pid, WATCHER_COMMAND);
  child.on('exit', () => {
    exited = true;
  });
  child.on('error', () => {
    exited = true;
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !interrupted) {
    const recorded = readOwner(file, process.env.PG_CONNECTIONS_RUN);
    if (recorded?.pid === child.pid && recorded.ticks === owner.ticks) {
      child.unref();
      process.exit(0);
    }
    if (exited) break;
    await delay(25);
  }
  throw { code: interrupted ? 'EINTR' : 'ETIMEDOUT' };
} catch (error) {
  await stop();
  try {
    rmSync(file, { force: true });
  } catch {
    /* unavailable ownership channel */
  }
  console.log(
    `::warning title=PostgreSQL connection margin::watcher did not start (${errorCode(error)})`,
  );
} finally {
  if (log !== undefined) closeSync(log);
}
process.exit(0);
