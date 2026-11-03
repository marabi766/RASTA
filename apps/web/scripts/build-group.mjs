// Wrapper endpoint for a LIVE supervisor. The wrapper never signals a numeric pgid.
// IPC endpoints cannot be reused for another process. Unexpected supervisor loss
// retires signalling permanently and makes shutdown unconfirmable, even on ESRCH.
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { groupAlive } from './build-lock.mjs';

const SUPERVISOR = fileURLToPath(new URL('./build-supervisor.mjs', import.meta.url));

export class BuildGroup {
  constructor(start, options) {
    this.options = options;
    this.final = false;
    this.absent = false;
    this.lost = false;
    this.quiescent = false;
    this.child = spawn(process.execPath, [SUPERVISOR], {
      detached: true,
      // No build config, NODE_OPTIONS or preload in the signal sender.
      env: { PATH: process.env.PATH },
      stdio: ['ignore', start.stdio, start.stdio, 'ipc'],
    });
    this.id = this.child.pid;
    this.root = new Promise((resolve) => {
      this.resolveRoot = resolve;
    });
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.child.on('message', (message) => {
      this.options.onGroupEvent?.(message.kind);
      if (message.kind === 'root') this.resolveRoot(message.pid);
      if (message.kind === 'root-exit') this.resolveExit(message);
      if (message.kind === 'quiescent') this.quiescent = true;
      if (message.kind === 'final') this.final = true;
    });
    const lost = () => {
      if (!this.final) this.lost = true;
      this.resolveRoot(undefined);
      this.resolveExit({ code: 1 });
    };
    this.child.on('error', lost);
    this.child.on('exit', lost);
    this.child.on('disconnect', lost);
    this.send({ kind: 'start', ...start });
  }

  send(message) {
    if (this.absent || this.final || this.lost || !this.child.connected) return;
    this.options.onGroupEvent?.(`send-${message.kind}`);
    this.child.send(message, (error) => {
      if (error) this.lost = true;
    });
  }

  probe() {
    if (this.absent) return false;
    const alive = (this.options.probeGroup ?? groupAlive)(this.id);
    if (!alive) {
      this.absent = true; // Only definite ESRCH; never revive a retired identity.
      this.options.onGroupEvent?.('absent');
    }
    return alive;
  }

  async writersGone(ms) {
    const deadline = performance.now() + ms;
    while (!this.quiescent) {
      if (this.stopping || this.lost || performance.now() >= deadline) return false;
      await sleep(10);
    }
    return !this.lost;
  }

  stop() {
    // FIRST caller starts the ONE operation, on a monotonic clock. Interrupts during
    // startup/publication/receipt/cleanup all join it; no path refreshes the budget.
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  async shutdown() {
    const graceMs = this.options.stopGraceMs ?? 5_000;
    const deadline = performance.now() + graceMs + (this.options.stopWaitMs ?? 30_000);
    const graceEnd = Math.min(deadline, performance.now() + graceMs);
    if (this.lost) return false;
    this.send({ kind: 'term' });
    while (!this.quiescent && !this.lost && performance.now() < graceEnd) await sleep(10);
    if (this.lost) return false;
    this.send({ kind: this.quiescent ? 'retire' : 'kill' });
    for (;;) {
      if (this.lost) return false;
      if (!this.probe()) return this.final;
      if (performance.now() >= deadline) return false;
      await sleep(10);
    }
  }

  disconnect() {
    if (this.child.connected) this.child.disconnect();
  }
}
