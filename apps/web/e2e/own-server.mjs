/**
 * Starts one server of the Playwright suite and reports it ready only while every
 * listener on its port belongs to the process tree this launcher started.
 *
 *     OWN_SERVER_COMMAND='<shell command>' node e2e/own-server.mjs <port>
 *
 * Playwright waits for the line `RASTA_E2E_OWNED <port>` on stdout instead of
 * polling a URL (`server-reuse.ts`), so "ready" can only mean "the server this
 * launch started is listening and nothing else is" (TASK 325, PR #675 review):
 *
 * - Before the command runs, any listener on the port, on any address family, is
 *   refused by name. A port whose owner cannot be listed is refused as well.
 * - The ownership check runs again for as long as the server lives, on every
 *   listening socket of the port (IPv4, IPv6, any address). A socket held by a
 *   process outside this tree, or one whose owner `ss` cannot show, kills the
 *   server and fails the launcher, so a foreign listener that binds late, binds
 *   on another family than ours, or replaces ours cannot stand in for it.
 * - The server exiting ends the launcher with its exit code.
 *
 * Linux only: it needs `ss` and `ps`; without them nothing can be proved and it
 * refuses. Only the Playwright config starts it, for local runs; CI starts its
 * servers on a fresh machine as before.
 */
/* global process, setInterval, clearInterval */
import { spawn, spawnSync } from 'node:child_process';

const MARKER = 'RASTA_E2E_OWNED';
const POLL_MS = 250;
const port = Number(process.argv[2]);
const command = process.env.OWN_SERVER_COMMAND ?? '';
if (!Number.isInteger(port) || port < 1 || port > 65535 || command === '') {
  process.stderr.write('own-server: needs a port argument and OWN_SERVER_COMMAND\n');
  process.exit(2);
}

function run(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 5_000 });
  return result.error || result.status !== 0 ? null : result.stdout;
}

/** Every listening socket on the port, whatever the address; null when `ss` cannot say. */
function listeners() {
  const out = run('ss', ['-H', '-ltnp', `sport = :${port}`]);
  if (out === null) return null;
  return out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => ({
      line: line.trim().replace(/\s+/g, ' '),
      pids: [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])),
    }));
}

/** This process and everything it started; null when the process table cannot be read. */
function ownTree() {
  const out = run('ps', ['-A', '-o', 'pid=,ppid=']);
  if (out === null) return null;
  const children = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) children.set(Number(m[2]), [...(children.get(Number(m[2])) ?? []), Number(m[1])]);
  }
  const tree = new Set([process.pid]);
  for (const pid of tree) for (const child of children.get(pid) ?? []) tree.add(child);
  return tree;
}

/** 'free' | 'owned' | 'foreign' (with the sockets) | 'unknown' (something could not be read). */
function verdict() {
  const sockets = listeners();
  const tree = ownTree();
  if (sockets === null || tree === null) return { state: 'unknown' };
  // A socket without a visible owner is not ours: fail closed.
  const foreign = sockets.filter((s) => s.pids.length === 0 || s.pids.some((p) => !tree.has(p)));
  if (foreign.length > 0) return { state: 'foreign', foreign };
  return { state: sockets.length > 0 ? 'owned' : 'free' };
}

function describe(socket) {
  const who = socket.pids.map((pid) => {
    const args = run('ps', ['-o', 'args=', '-p', String(pid)])?.trim();
    return args ? `pid ${pid} (${args})` : `pid ${pid}`;
  });
  return `${socket.line} held by ${who.join(', ') || 'a process that could not be identified'}`;
}

function stop(code, message) {
  const tree = ownTree() ?? new Set();
  for (const pid of tree) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  if (message) process.stderr.write(`own-server: ${message}\n`);
  process.exit(code);
}

function refuse(found) {
  const detail =
    found.state === 'foreign'
      ? found.foreign.map(describe).join('; ')
      : 'who holds it could not be read (is `ss` installed?)';
  stop(
    1,
    `port ${port} is held by a server this run did not start: ${detail}. Playwright would test ` +
      'the wrong server. Stop that process and run again.',
  );
}

const first = verdict();
if (first.state !== 'free') refuse(first);

const child = spawn(command, { shell: true, stdio: ['ignore', 'ignore', 'inherit'] });
child.on('exit', (code) => stop(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(1));

let ready = false;
const timer = setInterval(() => {
  const found = verdict();
  // Whatever stops being provable once the server is up is not tolerated; a read that fails
  // is only retried, and "ready" is never said on it.
  if (found.state === 'foreign') {
    clearInterval(timer);
    refuse(found);
  }
  if (found.state === 'owned' && !ready) {
    ready = true;
    process.stdout.write(`${MARKER} ${port}\n`);
  }
}, POLL_MS);
