// The live group leader is the ONLY cleanup signal sender. A wrapper-side pid probe
// followed by kill(-pgid) would still race leader death and PGID reuse. Here the sender
// is itself in that group at the signal syscall. No config/preload runs in this process.
import { execFile, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

let root;
let rootExited = false;
let terminal = false;
let connected = true;
let checking = false;
let quiescent = false;
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.on('SIGHUP', () => {});

function report(message, then) {
  if (!connected) return then?.();
  process.send(message, (error) => {
    if (error) connected = false;
    then?.();
  });
}

function signalOwnGroup(signal) {
  try {
    process.kill(-process.pid, signal);
  } catch {
    // Fixed failure behavior: the wrapper loses this identity and refuses. Never
    // expose an OS error (or give another process a numeric group to signal).
    process.exit(70);
  }
}

process.on('disconnect', () => {
  connected = false;
});
process.on('message', (message) => {
  if (terminal) return;
  if (message.kind === 'start' && !root) {
    root = spawn(process.execPath, [message.nextBin, 'build'], {
      cwd: message.cwd,
      env: { ...message.env, RASTA_BUILD_GROUP: String(process.pid) },
      detached: false,
      stdio: message.stdio,
    });
    root.once('error', () => {
      rootExited = true;
      report({ kind: 'root-exit', code: 1 });
    });
    root.once('exit', (code, signal) => {
      rootExited = true;
      report({ kind: 'root-exit', code, signal });
    });
    report({ kind: 'root', pid: root.pid });
  } else if (message.kind === 'term') {
    signalOwnGroup('SIGTERM');
  } else if (message.kind === 'kill') {
    // Announce the FINAL possible signal before performing it. Even if the wrapper
    // dies here, this live process still reserves the group at the syscall.
    terminal = true;
    report({ kind: 'final' }, () => signalOwnGroup('SIGKILL'));
  } else if (message.kind === 'retire' && quiescent) {
    terminal = true;
    report({ kind: 'final' }, () => process.exit(0));
  }
});

// POSIX ps on Linux and macOS. Only a complete successful census proves no writers.
// Probe failures never authorize retirement. The census itself joins the group, and
// has exited before its callback; exclude only the live supervisor, never zombies.
async function writersGone() {
  return new Promise((resolve) => {
    const census = execFile(
      'ps',
      ['-axo', 'pid=,pgid='],
      { timeout: 1_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(false);
        const rows = stdout
          .trim()
          .split('\n')
          .map((line) => line.trim().split(/\s+/).map(Number));
        if (
          !rows.length ||
          rows.some(
            ([pid, pgid, ...extra]) =>
              extra.length ||
              !Number.isInteger(pid) ||
              pid <= 0 ||
              !Number.isInteger(pgid) ||
              pgid < 0,
          )
        )
          return resolve(false);
        const members = rows.filter(([, pgid]) => pgid === process.pid).map(([pid]) => pid);
        // ps was a member while taking its snapshot, but is now reaped by execFile.
        resolve(
          members.includes(process.pid) &&
            members.every((pid) => pid === process.pid || pid === census.pid),
        );
      },
    );
  });
}

// A disconnected wrapper cannot retire us while writers live. Once they are gone,
// exit without signalling anything; a future wrapper can recover the abandoned lock.
while (!terminal) {
  if (!connected && (!root || quiescent)) process.exit(0);
  if (rootExited && !quiescent && !checking) {
    checking = true;
    if (await writersGone()) {
      quiescent = true;
      report({ kind: 'quiescent' });
      if (!connected) process.exit(0);
    }
    checking = false;
  }
  await sleep(25);
}
