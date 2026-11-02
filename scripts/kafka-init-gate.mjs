#!/usr/bin/env node
/**
 * Detached Compose is not a readiness signal. Own the startup and confirm the
 * intended kafka-init invocation before the caller applies ACLs/starts clients.
 * D-066: one operator/provisioner, no concurrent alters or broker-default writes.
 * No retries/recovery here; a timeout leaves the provisioner alone. NEVER reset.
 */
import { execFile, spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 3_600_000;
const ID = /^[a-f0-9]{64}$/;
const SERVICES = new Set(['kafka', 'kafka-init', 'kafka-tls']);

class GateFailure extends Error {
  constructor(step, status = 1) {
    super(
      `kafka-init readiness failed: ${step}. Stop here; do not apply ACLs or start consumers. ` +
        'Inspect kafka-init locally; do not use infra:reset as recovery.',
    );
    this.status = status;
  }
}

async function main() {
  const services = process.argv.slice(2);
  if (services.some((service) => !SERVICES.has(service))) {
    throw new GateFailure('unsupported service argument');
  }
  const setting = process.env.RASTA_KAFKA_INIT_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS);
  const timeoutMs = /^\d+$/.test(setting) ? Number(setting) : NaN;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new GateFailure('invalid RASTA_KAFKA_INIT_TIMEOUT_MS');
  }
  const deadline = Date.now() + timeoutMs;
  // Capture only requested metadata, never inspect.Config/env or foreign stderr.
  const docker = (step, args) =>
    new Promise((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return reject(new GateFailure(`${step} timed out`, 124));
      execFile(
        'docker',
        args,
        { timeout: remaining, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
        (error, stdout) => {
          if (error)
            reject(
              new GateFailure(
                `${step}${error.killed ? ' timed out' : ' command failed'}`,
                error.killed ? 124 : 1,
              ),
            );
          else resolve(stdout.trim());
        },
      );
    });
  const startup = () =>
    new Promise((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return reject(new GateFailure('compose startup timed out', 124));
      // Pull/progress output is unbounded and may contain foreign diagnostics.
      // Drain both pipes without accumulating; only metadata uses maxBuffer.
      const child = spawn('docker', ['compose', 'up', '-d', ...services], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.resume();
      child.stderr.resume();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, remaining);
      child.on('error', () => {
        clearTimeout(timer);
        reject(new GateFailure('compose startup command failed'));
      });
      child.on('close', (status) => {
        clearTimeout(timer);
        if (timedOut) reject(new GateFailure('compose startup timed out', 124));
        else if (status !== 0) reject(new GateFailure('compose startup command failed'));
        else resolve();
      });
    });
  const container = async (optional = false) => {
    const id = await docker('locate kafka-init', [
      'compose',
      'ps',
      '--all',
      '--quiet',
      'kafka-init',
    ]);
    if (optional && id === '') return undefined;
    if (!ID.test(id)) throw new GateFailure('missing or ambiguous kafka-init container');
    return id;
  };
  const inspect = async (id) => {
    const output = await docker('inspect kafka-init state', [
      'inspect',
      '--format',
      '{{json .State}}',
      id,
    ]);
    let state;
    try {
      state = JSON.parse(output);
    } catch {
      throw new GateFailure('unreadable kafka-init state');
    }
    if (
      !state ||
      typeof state !== 'object' ||
      typeof state.Running !== 'boolean' ||
      !['created', 'running', 'exited'].includes(state.Status) ||
      typeof state.StartedAt !== 'string' ||
      !Number.isFinite(Date.parse(state.StartedAt)) ||
      !Number.isInteger(state.ExitCode) ||
      state.ExitCode < 0 ||
      state.ExitCode > 255 ||
      state.Dead !== false ||
      state.OOMKilled !== false ||
      state.Restarting !== false
    ) {
      throw new GateFailure('unconfirmed kafka-init state');
    }
    return state;
  };

  const previousId = await container(true);
  const previous = previousId ? await inspect(previousId) : undefined;
  if (previous && (previous.Running || previous.Status === 'running')) {
    throw new GateFailure('kafka-init already running; another startup may be active (D-066)');
  }
  if (services.length && !services.includes('kafka-init')) services.push('kafka-init');
  await startup();
  const id = await container();
  const started = await inspect(id);
  if (
    Date.parse(started.StartedAt) <= 0 ||
    (id === previousId && started.StartedAt === previous.StartedAt)
  ) {
    throw new GateFailure('kafka-init did not start a new invocation');
  }
  const result = await docker('wait for kafka-init', ['wait', id]);
  if (!/^(0|[1-9]\d{0,2})$/.test(result) || Number(result) > 255) {
    throw new GateFailure('unreadable kafka-init wait result');
  }
  const finished = await inspect(id);
  if (
    (await container()) !== id ||
    finished.StartedAt !== started.StartedAt ||
    finished.Status !== 'exited' ||
    finished.Running ||
    finished.ExitCode !== Number(result)
  ) {
    throw new GateFailure('kafka-init completion belongs to a different or unconfirmed invocation');
  }
  if (finished.ExitCode !== 0)
    throw new GateFailure(`kafka-init exited ${finished.ExitCode}`, finished.ExitCode);
  process.stdout.write('kafka-init completed successfully; topic provisioning confirmed.\n');
}

main().catch((error) => {
  // Only our fixed diagnostics are safe to print; Docker errors may carry env values.
  const failure =
    error instanceof GateFailure ? error : new GateFailure('unexpected lifecycle error');
  process.stderr.write(`${failure.message}\n`);
  process.exitCode = failure.status;
});
