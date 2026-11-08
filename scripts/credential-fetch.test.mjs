import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { CredentialRedirectRefusedError, credentialFetch } from './credential-fetch.mjs';
import {
  CredentialEnvironmentRefusedError,
  refusedBeforeSending,
} from '../packages/config/src/credential-environment.js';
import { AUDITED_TRANSPORTS } from './raw-http-boundary-rule.mjs';

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

// FU-249: Node's fetch reads inherited members of the option objects it builds,
// even from an init with no prototype. Here, unlike under jest, this module and
// Node's fetch share one realm and one global dispatcher slot.
const capturedBy = (captured) => ({
  dispatch(options, handler) {
    captured.push(options.headers);
    queueMicrotask(() => handler.onError(new Error('captured')));
    return true;
  },
});

async function environmentProbe(alter) {
  const received = [];
  const captured = [];
  const { server, origin } = await listen((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push(`${req.method} ${req.headers.authorization} ${body}`);
      res.end('ok');
    });
  });
  const restore = alter(capturedBy(captured));
  try {
    const outcome = await credentialFetch(`${origin}/api`, {
      method: 'POST',
      headers: { authorization: AUTH },
    }).then(
      () => 'sent',
      (error) => error,
    );
    return { outcome, received, captured };
  } finally {
    restore();
    await close(server);
  }
}

for (const [name, alter] of [
  [
    'an inherited dispatcher',
    (dispatcher) => {
      Object.prototype.dispatcher = dispatcher;
      return () => delete Object.prototype.dispatcher;
    },
  ],
  [
    'an inherited body',
    () => {
      Object.prototype.body = 'injected-body-sentinel';
      return () => delete Object.prototype.body;
    },
  ],
  [
    'a replaced global dispatcher',
    (dispatcher) => {
      const slot = Symbol.for('undici.globalDispatcher.1');
      const original = globalThis[slot];
      globalThis[slot] = dispatcher;
      return () => (globalThis[slot] = original);
    },
  ],
])
  test(`${name}: the credential is refused before anything is sent (FU-249)`, async () => {
    const { outcome, received, captured } = await environmentProbe(alter);
    assert.ok(outcome instanceof CredentialEnvironmentRefusedError, String(outcome));
    assert.deepEqual(captured, []);
    assert.deepEqual(received, []);
  });

test('an unaltered runtime still sends the credential (FU-249)', async () => {
  const { outcome, received } = await environmentProbe(() => () => undefined);
  assert.equal(outcome, 'sent');
  assert.deepEqual(received, [`POST ${AUTH} `]);
});

test('its own refusal is known unsent; one escaping from its transport is not (FU-249)', async () => {
  /** A fresh refusal of this transport's own check: marked, nothing sent. */
  const ownRefusal = async () => {
    Object.defineProperty(Object.prototype, 'fu249Probe', { value: 1, configurable: true });
    try {
      const own = await credentialFetch('http://127.0.0.1:9/', {}).catch((error) => error);
      assert.ok(own instanceof CredentialEnvironmentRefusedError, String(own));
      assert.equal(refusedBeforeSending(own), true);
      return own;
    } finally {
      delete Object.prototype.fu249Probe;
    }
  };
  // Thrown by the transport, or by the answer it returned: either way after the check.
  for (const route of [
    (own) => async () => {
      throw own;
    },
    (own) => async () => ({
      get status() {
        throw own;
      },
    }),
  ]) {
    const own = await ownRefusal();
    const escaped = await credentialFetch('http://127.0.0.1:9/', {}, route(own)).catch((e) => e);
    assert.equal(escaped, own);
    assert.equal(refusedBeforeSending(escaped), false);
  }
});

test('every audited transport runs the environment check before it sends, or says why not', () => {
  const CHECKED = {
    'packages/nest-common/src/http/internal-fetch.ts': 'fetchImpl(input, { ...init, redirect',
    'apps/web/src/server/credential-fetch.ts': 'fetchImpl(input, { ...init, redirect',
    'apps/web/src/server/signed-url-upload.ts': 'fetchImpl(url, { ...init, method',
    'scripts/credential-fetch.mjs': 'fetchImpl(input, { ...init, redirect',
  };
  // Not yet checked: listed in FU-249's STATUS as the next part, or no credential set by code.
  const UNCHECKED = new Set([
    'packages/config/src/credential-environment.js',
    'apps/web/src/lib/session-refusal.ts',
    'scripts/test-stall-watchdog.mjs',
    'scripts/workspace-module.mjs',
    'packages/testing/src/guarded-http.ts',
    'packages/testing/src/redirect-probe.ts',
    'tests/e2e/src/http.ts',
    'tests/e2e/src/expect.ts',
    'apps/web/e2e/expect.ts',
  ]);
  for (const file of Object.keys(AUDITED_TRANSPORTS)) {
    assert.ok(Object.hasOwn(CHECKED, file) || UNCHECKED.has(file), `${file} is not classified`);
  }
  for (const [file, send] of Object.entries(CHECKED)) {
    const text = readFileSync(`${root}${file}`, 'utf8');
    const check = text.indexOf('  refuseAlteredEnvironment(fetchImpl);\n');
    assert.ok(check > 0 && text.indexOf(send) > check, `${file}: the check precedes the send`);
    assert.equal(text.split(send).length, 2, `${file}: one send`);
    // Whatever the send throws is disowned: it may have sent (refusedBeforeSending).
    const disowned = text.indexOf('    throw disownRefusal(error);\n');
    assert.ok(disowned > text.indexOf(send), `${file}: the send's failure is disowned`);
    assert.equal(text.split('disownRefusal(').length, 2, `${file}: one disown`);
    assert.match(
      text,
      /from '(?:@rasta\/config|\.\.\/packages\/config\/src\/credential-environment\.js)';/,
      file,
    );
  }
});
