// Imported ONLY by the Jest driver bootstrap, never by a production script/config.
// Keep a second, persistent channel to the live supervisor across wrapper SIGKILL.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { connect } from 'node:net';
import process from 'node:process';

export async function supervise(socketPath, supervisorUrl) {
  const socket = connect(socketPath);
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  let root;
  const spawn = cp.spawn;
  cp.spawn = (...args) => {
    const child = spawn(...args);
    root ??= child;
    return child;
  };
  syncBuiltinESMExports();
  let buffer = '';
  socket.on('data', (data) => {
    buffer += data;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const { target, signal } = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (target === 'group') {
        // Use the SAME production IPC handler. Only the live leader self-signals.
        process.emit('message', { kind: 'kill' });
      } else if (target === 'root') {
        // This controller is the root's parent. Until Node reaps it, its PID cannot
        // be reused. Node records exitCode/signalCode in that same event-loop turn;
        // no await/probe occurs between this gate and ChildProcess.kill().
        if (root && root.exitCode === null && root.signalCode === null) root.kill(signal);
      }
    }
  });
  socket.on('error', () => socket.destroy());
  // EOF retires the test channel: no reconnect, numeric fallback, or late signal.
  await import(supervisorUrl);
}
