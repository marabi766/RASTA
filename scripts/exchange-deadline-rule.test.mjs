import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import exchangeDeadline from './exchange-deadline-rule.mjs';

const linter = new Linter();
const check = (code) =>
  linter.verify(code, [
    {
      plugins: { internal: { rules: { 'exchange-deadline': exchangeDeadline } } },
      rules: { 'internal/exchange-deadline': 'error' },
    },
  ]);

// The two shapes #502 r1 F1 found: the timer cleared as soon as the headers arrive.
test('refuses a body read after a clearTimeout in a finally (the reproduced shape)', () => {
  const messages = check(`
    async function call(sender) {
      const timer = setTimeout(() => controller.abort(), 100);
      let response;
      try {
        response = await sender.send(url, { signal });
      } finally {
        clearTimeout(timer);
      }
      const text = await response.text();
      return text;
    }`);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, 'internal/exchange-deadline');
});

for (const read of [
  'response.json()',
  'response.arrayBuffer()',
  'response.blob()',
  'response.formData()',
  'response.bytes()',
  'response.body.getReader()',
  'readCapped(response, 1024)',
  'this.readCapped(response, 1024)',
]) {
  test(`refuses a late read: ${read}`, () => {
    assert.equal(
      check(`async function f(response) { clearTimeout(timer); await ${read}; }`).length,
      1,
    );
  });
}

test('refuses a late read in an arrow function and in a method', () => {
  assert.equal(check('const f = async (r) => { clearTimeout(t); return r.text(); };').length, 1);
  assert.equal(
    check('class C { async m(r) { globalThis.clearTimeout(t); return r.json(); } }').length,
    1,
  );
});

test('allows the read inside the try, before the finally clears the timer', () => {
  assert.deepEqual(
    check(`
      async function call(sender) {
        const timer = setTimeout(() => controller.abort(), 100);
        try {
          const response = await sender.send(url, { signal });
          return await response.text();
        } catch (error) {
          throw wrap(error);
        } finally {
          clearTimeout(timer);
        }
      }`),
    [],
  );
});

test('allows reads in a catch that precede the finally', () => {
  assert.deepEqual(
    check(`
      async function f(sender) {
        try { return await sender.send(); }
        catch { await response.body?.cancel(); await readCapped(response, 1); }
        finally { clearTimeout(timer); }
      }`),
    [],
  );
});

test('leaves calls that merely share a name alone', () => {
  // Express-style `res.json(body)` has an argument; a read with no clearTimeout is not a case.
  assert.deepEqual(check('function f(res) { clearTimeout(t); res.json({ ok: true }); }'), []);
  assert.deepEqual(check('async function f(r) { return r.text(); }'), []);
});

test('allows a body read in a different function than the one that clears', () => {
  assert.deepEqual(
    check('function stop() { clearTimeout(t); } async function read(r) { return r.text(); }'),
    [],
  );
});

// The rule is only a boundary if the real workspace configs load it.
const root = fileURLToPath(new URL('../', import.meta.url));
for (const [workspace, filename] of [
  ['services/marketplace-service', 'src/economic/probe.ts'],
  ['services/notification-service', 'src/recipients/probe.ts'],
  ['packages/nest-common', 'src/http/probe.ts'],
]) {
  test(`real workspace ESLint refuses a late body read in ${workspace}`, () => {
    const result = spawnSync(
      process.execPath,
      [
        `${root}node_modules/eslint/bin/eslint.js`,
        '--stdin',
        '--stdin-filename',
        filename,
        '--format',
        'json',
      ],
      {
        cwd: `${root}${workspace}`,
        input:
          'export async function f(r: Response, timer: NodeJS.Timeout) { clearTimeout(timer); return r.text(); }',
        encoding: 'utf8',
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const [{ messages }] = JSON.parse(result.stdout);
    assert.ok(
      messages.some(
        ({ ruleId, severity }) => ruleId === 'internal/exchange-deadline' && severity === 2,
      ),
      result.stdout,
    );
  });
}
