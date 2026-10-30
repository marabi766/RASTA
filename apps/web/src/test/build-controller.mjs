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
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

async function open(path) {
  const socket = connect(path);
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  socket.on('error', () => socket.destroy());
  return socket;
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

  let buffer = '';
  const onData = (data) => {
    buffer += data;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const { id, target, signal } = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (target === 'group') {
        // Use the SAME production IPC handler. Only the live leader self-signals.
        pendingAck = id;
        process.emit('message', { kind: 'kill' });
        if (pendingAck === id) send([]);
      } else if (target === 'root') {
        // This controller is the root's parent. Until Node reaps it, its PID cannot
        // be reused. Node records exitCode/signalCode in that same event-loop turn;
        // no await/probe occurs between this gate and ChildProcess.kill().
        const acted = Boolean(
          root && root.exitCode === null && root.signalCode === null && root.kill(signal),
        );
        send([{ kind: 'ACK', id, acted }]);
      } else socket.destroy(); // Protocol error: unannounced EOF, so LOST.
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
      commands.on('data', onData);
    });
  });
  // Test-only widening of the startup window (R6-1 regression); 0 in every other case.
  if (importDelayMs) await sleep(importDelayMs);
  // EOF retires the test channel: no reconnect, numeric fallback, or late signal.
  await import(supervisorUrl);
}
