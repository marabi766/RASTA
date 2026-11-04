/**
 * Is anything listening on a loopback port, and what does it answer for one
 * path? Run in a child by `server-reuse.ts` so the Playwright config can stay
 * synchronous. Prints one JSON line:
 * `{ "occupied": boolean, "status": number|null, "controlStatus": number|null }`.
 * The control path is one no real server has: a listener that answers it with 200 answers everything,
 * so its answer to the path proves nothing.
 *
 *     node probe-port.mjs <port> [<path> [<control path>]]
 *
 * A connection error that means "nothing there" (refused, no such address
 * family) is a free port; every other outcome — a timeout, a reset, a permission
 * error — is NOT proof of a free port, so it counts as occupied. The request is
 * a bare GET to loopback that carries no credential and reads only the status
 * line, so it is not an HTTP client in the sense of the raw-http rule.
 */
/* global process, setTimeout, clearTimeout */
import { connect } from 'node:net';

const [portArg, pathArg = '', controlArg = ''] = process.argv.slice(2);
const port = Number(portArg);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(`probe-port: not a port: ${portArg}\n`);
  process.exit(2);
}

const FREE = new Set(['ECONNREFUSED', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETUNREACH']);
const HOSTS = ['127.0.0.1', '::1'];
const DEADLINE_MS = 3_000;

/** @returns {Promise<{occupied: boolean, status: number|null}>} */
function probe(host, path) {
  return new Promise((resolve) => {
    let status = null;
    let buffered = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = connect({ port, host });
    const timer = setTimeout(() => done({ occupied: true, status }), DEADLINE_MS);
    socket.on('connect', () => {
      if (path === '') return done({ occupied: true, status: null });
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      buffered += chunk.toString('latin1');
      const line = /^HTTP\/1\.[01] (\d{3})/.exec(buffered);
      if (line) {
        status = Number(line[1]);
        done({ occupied: true, status });
      }
    });
    socket.on('error', (error) => done({ occupied: !FREE.has(error.code), status }));
    socket.on('close', () => done({ occupied: true, status }));
  });
}

const results = await Promise.all(HOSTS.map((host) => probe(host, pathArg)));
const controls = await Promise.all(HOSTS.map((host) => probe(host, controlArg)));
process.stdout.write(
  `${JSON.stringify({
    occupied: results.some((r) => r.occupied),
    status: results.find((r) => r.status !== null)?.status ?? null,
    controlStatus: controls.find((r) => r.status !== null)?.status ?? null,
  })}\n`,
);
