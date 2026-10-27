#!/usr/bin/env node
/** Bounded ownership handshake; a timed-out launch cannot query after the report. */
import { spawn } from 'node:child_process';
import { closeSync, openSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { errorCode, readOwner, TIMING } from './ci-pg-connections-lib.mjs';

const file = process.env.PG_CONNECTIONS_OWNER;
let child;
let log;
try {
  rmSync(file, { force: true });
  log = openSync(`${file}.log`, 'w', 0o600);
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./ci-pg-connections-watch.mjs', import.meta.url))],
    {
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    },
  );
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  child.on('error', () => {
    exited = true;
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const owner = readOwner(file, process.env.PG_CONNECTIONS_RUN);
    if (owner?.pid === child.pid) {
      child.unref();
      process.exit(0);
    }
    if (exited) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw { code: 'ETIMEDOUT' };
} catch (error) {
  if (child?.pid) {
    // This PID/group is owned by this spawn, independent of the failed handshake.
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already exited */
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, TIMING.killWaitMs)),
    ]);
    child.unref();
  }
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
