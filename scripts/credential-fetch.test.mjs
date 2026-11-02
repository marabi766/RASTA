import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { CredentialRedirectRefusedError, credentialFetch } from './credential-fetch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const SECRET = 'credential-sentinel-7f3a';
const BODY_SENTINEL = 'redirect-body-sentinel-91c2';
const AUTH = `Basic ${Buffer.from(`admin:${SECRET}`).toString('base64')}`;

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function close(...servers) {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

/** Everything written to the console or the process streams while `work` runs. */
async function captured(work) {
  const lines = [];
  const record = (...args) => lines.push(args.map(String).join(' '));
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  Object.assign(console, { log: record, info: record, warn: record, error: record });
  const restore = [() => Object.assign(console, originals)];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write;
    stream.write = (chunk, ...rest) => {
      lines.push(String(chunk));
      return original.call(stream, chunk, ...rest);
    };
    restore.push(() => (stream.write = original));
  }
  try {
    return { result: await work(), logs: lines.join('\n') };
  } finally {
    for (const undo of restore) undo();
  }
}

for (const status of [301, 302, 303, 307, 308])
  for (const sameOrigin of [false, true])
    for (const method of ['GET', 'POST']) {
      test(`${method} ${status} sameOrigin=${sameOrigin}: refused, never followed, nothing disclosed`, async () => {
        const target = [];
        const sent = [];
        const other = await listen((req, res) => {
          target.push(req.headers);
          res.writeHead(200).end('{}');
        });
        const source = await listen((req, res) => {
          req.resume();
          if (req.url === '/redirect-target') {
            target.push(req.headers);
            res.writeHead(200).end('{}');
            return;
          }
          sent.push({ method: req.method, authorization: req.headers.authorization });
          res
            .writeHead(status, {
              location: sameOrigin ? '/redirect-target' : `${other.origin}/redirect-target`,
            })
            .end(BODY_SENTINEL);
        });
        try {
          const { result: error, logs } = await captured(() =>
            credentialFetch(`${source.origin}/api/x`, {
              method,
              headers: { Authorization: AUTH },
              ...(method === 'POST' ? { body: `secret=${SECRET}` } : {}),
            }).then(
              () => assert.fail('a redirect must be refused'),
              (thrown) => thrown,
            ),
          );
          assert.ok(error instanceof CredentialRedirectRefusedError);
          assert.equal(error.message, 'Credential-bearing redirect refused');
          assert.deepEqual(sent, [{ method, authorization: AUTH }]);
          assert.deepEqual(target, []);
          const surfaced = `${error.message}\n${error.stack}\n${JSON.stringify(error)}\n${logs}`;
          for (const sentinel of [
            SECRET,
            AUTH,
            BODY_SENTINEL,
            other.origin,
            source.origin,
            'redirect-target',
          ])
            assert.ok(!surfaced.includes(sentinel), `disclosed ${sentinel}`);
        } finally {
          await close(source.server, other.server);
        }
      });
    }

test('a redirect status without a Location is refused too', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const source = await listen((req, res) => res.writeHead(status).end(BODY_SENTINEL));
    try {
      await assert.rejects(
        credentialFetch(source.origin, { headers: { Authorization: AUTH } }),
        CredentialRedirectRefusedError,
      );
    } finally {
      await close(source.server);
    }
  }
});

test('every other status is the answer, 304 and a 201 Location included', async () => {
  for (const status of [200, 201, 204, 300, 304, 305, 399, 400, 401, 404, 500, 503]) {
    const source = await listen((req, res) => {
      res
        .writeHead(status, { location: '/created/1', etag: '"v1"' })
        .end([204, 304].includes(status) ? undefined : 'answer');
    });
    try {
      const response = await credentialFetch(source.origin, { headers: { Authorization: AUTH } });
      assert.equal(response.status, status);
      assert.equal(response.headers.get('location'), '/created/1');
      assert.equal(response.headers.get('etag'), '"v1"');
      assert.equal(await response.text(), [204, 304].includes(status) ? '' : 'answer');
    } finally {
      await close(source.server);
    }
  }
});

test('a caller cannot turn redirect following back on, and the rest of init is kept', async () => {
  const seen = [];
  const signal = AbortSignal.timeout(5_000);
  await credentialFetch(
    'http://source.test',
    { method: 'PUT', headers: { authorization: AUTH }, body: 'b', redirect: 'follow', signal },
    async (input, init) => {
      seen.push([input, init]);
      return new Response('{}');
    },
  );
  assert.deepEqual(seen, [
    [
      'http://source.test',
      { method: 'PUT', headers: { authorization: AUTH }, body: 'b', redirect: 'manual', signal },
    ],
  ]);
});

test('refuses without waiting for a body cancellation that never settles', async () => {
  let cancelled = 0;
  const response = {
    status: 307,
    body: {
      cancel: () => {
        cancelled += 1;
        return new Promise(() => undefined);
      },
    },
  };
  await assert.rejects(
    credentialFetch('http://source.test', {}, async () => response),
    CredentialRedirectRefusedError,
  );
  assert.equal(cancelled, 1);
});

test('every credential transport copy refuses the same five statuses with manual redirects', () => {
  // The original (services), the portal's copy, this copy, and the E2E harness's hand guard.
  for (const file of [
    'packages/nest-common/src/http/internal-fetch.ts',
    'apps/web/src/server/credential-fetch.ts',
    'scripts/credential-fetch.mjs',
    'tests/e2e/src/http.ts',
  ]) {
    const text = readFileSync(`${root}${file}`, 'utf8');
    assert.match(text, /if \(\[301, 302, 303, 307, 308\]\.includes\(response\.status\)\) \{/, file);
    assert.match(text, /void response\.body\?\.cancel\(\)\.catch\(\(\) => undefined\);/, file);
    if (file === 'tests/e2e/src/http.ts') assert.match(text, /\n\s+redirect: 'manual',\n/, file);
    else assert.match(text, /fetchImpl\(input, \{ \.\.\.init, redirect: 'manual' \}\)/, file);
  }
});
