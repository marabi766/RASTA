// Imported ONLY by the Jest driver bootstrap, never by a production script/config.
// Keep a second, persistent channel to the live supervisor across wrapper SIGKILL.
//
// ONE acknowledged lifecycle on that channel (R6-1). Connectivity is never readiness:
//   READY       only once the PRODUCTION supervisor 'message' handler is installed;
//               command bytes stay unread in the command channel until then.
//   ACK         per command, after the production handler (or root gate) ran.
//   FINAL       flushed BEFORE the supervisor's own final group SIGKILL is performed.
//   NORMAL_END  flushed BEFORE the supervisor's own successful exit.
// EOF without FINAL/NORMAL_END is a lost lifetime; the test side never infers success.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { connect } from 'node:net';
import { constants } from 'node:os';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

async function open(path) {
  const socket = connect(path);
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  socket.on('error', () => socket.destroy());
  return socket;
}

// The ONE schema check for the test's commands: a non-null plain object with a positive
// safe-integer `id`, and either `group` or `root` with a known signal name. Anything else
// is `undefined` (a refused command); this never throws.
function decodeCommand(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { id, target, signal } = value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return undefined;
  if (target === 'group') return { id, target };
  if (target === 'root' && typeof signal === 'string' && Object.hasOwn(constants.signals, signal))
    return { id, target, signal };
  return undefined;
}

export async function supervise(socketPath, supervisorUrl, importDelayMs = 0) {
  // Two ONE-WAY channels. The test never writes to `socket`, so a command write that
  // fails against an ending supervisor cannot discard an unread announcement.
  const socket = await open(socketPath);
  const commands = await open(`${socketPath}.commands`);
  let root;
  const spawn = cp.spawn;
  cp.spawn = (...args) => {
    const child = spawn(...args);
    root ??= child;
    return child;
  };
  syncBuiltinESMExports();

  let pendingAck;
  const send = (messages, then = () => {}) => {
    // A group ACK still owed rides with any ending announcement, in order.
    if (pendingAck !== undefined) messages.push({ kind: 'ACK', id: pendingAck, acted: true });
    pendingAck = undefined;
    if (socket.destroyed) return then();
    socket.write(messages.map((m) => JSON.stringify(m) + '\n').join(''), () => then());
  };
  // The supervisor's ending syscalls run only after their announcement is flushed.
  const exit = process.exit.bind(process);
  let exiting = false;
  process.exit = (code) => {
    if (code !== 0) return exit(code);
    if (exiting) return;
    exiting = true;
    send([{ kind: 'NORMAL_END' }], () => exit(0));
  };
  const kill = process.kill.bind(process);
  process.kill = (target, signal) => {
    if (target !== -process.pid || signal !== 'SIGKILL') return kill(target, signal);
    send([{ kind: 'FINAL' }], () => {
      try {
        kill(target, signal);
      } catch {
        exit(70); // The production fallback for a failed self-signal.
      }
    });
    return true;
  };

  // A refused command (undecodable, unknown, or an incomplete frame at EOF) is never acted
  // on: it ends the event channel without an announcement, so the test side reads LOST.
  const refuse = () => {
    commands.destroy();
    socket.destroy();
  };
  let buffer = '';
  const onData = (data) => {
    buffer += data;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const command = decodeCommand(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (command === undefined) return refuse();
      const { id, target, signal } = command;
      if (target === 'group') {
        // Use the SAME production IPC handler. Only the live leader self-signals.
        pendingAck = id;
        process.emit('message', { kind: 'kill' });
        if (pendingAck === id) send([]);
      } else {
        // This controller is the root's parent. Until Node reaps it, its PID cannot
        // be reused. Node records exitCode/signalCode in that same event-loop turn;
        // no await/probe occurs between this gate and ChildProcess.kill().
        const acted = Boolean(
          root && root.exitCode === null && root.signalCode === null && root.kill(signal),
        );
        send([{ kind: 'ACK', id, acted }]);
      }
    }
  };
  // The supervisor module installs its handler during evaluation, then never resolves
  // its import (a top-level lifetime loop). 'newListener' runs just BEFORE the handler
  // is added; READY waits one tick, until it exists. IPC from the wrapper is buffered by
  // Node until a 'message' listener exists, so delaying the import loses nothing.
  process.on('newListener', function installed(event) {
    if (event !== 'message') return;
    process.off('newListener', installed);
    process.nextTick(() => {
      send([{ kind: 'READY', group: process.pid }]);
      commands.setEncoding('utf8');
      commands.on('data', onData);
      commands.once('end', () => buffer !== '' && refuse());
    });
  });
  // Test-only widening of the startup window (R6-1 regression); 0 in every other case.
  if (importDelayMs) await sleep(importDelayMs);
  // EOF retires the test channel: no reconnect, numeric fallback, or late signal.
  await import(supervisorUrl);
}
