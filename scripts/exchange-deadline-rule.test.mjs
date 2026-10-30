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
const refused = (code) => {
  const messages = check(code);
  assert.equal(messages.length, 1, JSON.stringify(messages));
  assert.equal(messages[0].ruleId, 'internal/exchange-deadline');
};
const allowed = (code) => assert.deepEqual(check(code), []);

// The two shapes #502 r1 F1 found, and what #507 r1 F2 showed the old order-based rule missed.
test('refuses the reproduced shape: timer cleared once the headers arrive, body read after', () => {
  refused(`
    async function call(sender) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      let response;
      try {
        response = await sender.send(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      return response.text();
    }`);
});

test('refuses the unawaited return in a try/finally (the finally runs before the read settles)', () => {
  refused(`
    async function call(sender) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        const response = await sender.send(url, { signal: controller.signal });
        return response.text();
      } finally {
        clearTimeout(timer);
      }
    }`);
});

test('refuses a refusal that returns without reading or cancelling the body (#507 r1 F1 shape)', () => {
  refused(`
    async function call(sender) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        const response = await sender.send(url, { signal: controller.signal });
        if (response.status !== 200) throw new Error('refused');
        return await response.json();
      } finally {
        clearTimeout(timer);
      }
    }`);
});

for (const [name, reader] of [
  ['a computed reader', "return response['text']();"],
  ['an aliased reader', 'const read = response.text.bind(response); return read();'],
  [
    'a reader acquired apart from its reads',
    'const r = response.body.getReader(); return r.read();',
  ],
  ['readCapped', 'return readCapped(response, 1024);'],
]) {
  test(`refuses the manual timer whatever the reader: ${name}`, () => {
    refused(`
      async function call(sender, controller) {
        const timer = setTimeout(() => controller.abort(), 100);
        try {
          const response = await sender.send(url, { signal: controller.signal });
          ${reader}
        } finally {
          clearTimeout(timer);
        }
      }`);
  });
}

for (const [name, timer] of [
  ['an inline arrow', 'setTimeout(() => controller.abort(), 100)'],
  [
    'an inline function with a block body',
    'setTimeout(function () { note(); controller.abort(); }, 100)',
  ],
  ['an optional call', 'setTimeout(() => controller?.abort(), 100)'],
  ['a computed member', "setTimeout(() => controller['abort'](), 100)"],
  ['an abort with a reason', 'setTimeout(() => controller.abort(new Error("late")), 100)'],
  ['a bound method', 'setTimeout(controller.abort.bind(controller), 100)'],
  ['a method reference', 'setTimeout(controller.abort, 100)'],
  ['a local arrow', 'setTimeout(stop, 100)'],
  ['globalThis.setTimeout', 'globalThis.setTimeout(() => controller.abort(), 100)'],
  ['a computed setTimeout', "globalThis['setTimeout'](() => controller.abort(), 100)"],
  [
    'abort behind a block and a flag',
    'setTimeout(() => { by ??= "deadline"; controller.abort(); }, 100)',
  ],
]) {
  test(`refuses an abort timer written as ${name}`, () => {
    refused(`
      function call(controller) {
        const stop = () => controller.abort();
        const timer = ${timer};
        return timer;
      }`);
  });
}

test('refuses an abort reached through a destructured binding or a function declaration', () => {
  refused('function f(controller) { const { abort } = controller; setTimeout(abort, 1); }');
  refused('function f(controller) { const { abort: stop } = controller; setTimeout(stop, 1); }');
  refused(
    'function f(controller) { function stop() { controller.abort(); } setTimeout(stop, 1); }',
  );
  refused('function f(controller) { const { abort } = controller; setTimeout(() => abort(), 1); }');
});

test('allows the shared boundary and a signal that needs no timer', () => {
  allowed(`
    async function call(sender) {
      return exchangeWithDeadline(1000, (signal) => sender.send(url, { signal }), (r) => r.json());
    }`);
  allowed(`
    async function call(sender) {
      return upstreamExchange('x', 1000, (signal) => sender.send(url, { signal }), (r) => r.json());
    }`);
  allowed(
    'async function f(s) { return (await s.send(u, { signal: AbortSignal.timeout(100) })).text(); }',
  );
});

test('does not flag a clearTimeout that belongs to something else (#507 r1 F2 false positive)', () => {
  allowed('async function f(response) { clearTimeout(unrelated); return await response.text(); }');
  allowed('async function f(r) { clearTimeout(t); return r.json(); }');
  allowed('class C { async m(r) { globalThis.clearTimeout(t); return r.json(); } }');
});

test('allows timers that abort nothing: sleeps, retries, shutdown bounds', () => {
  allowed('const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));');
  allowed('function f() { return new Promise((r) => { setTimeout(r, 5); }); }');
  allowed("function f(settle) { setTimeout(() => settle('abandoned'), 100); }");
  allowed('function f() { setTimeout(wake, 100); }');
  allowed('function f() { setTimeout(() => emit({ abort: true }), 100); }');
});

test('does not treat a parameter named like an abort timer callback as one', () => {
  // The enclosing function aborts elsewhere; the callback handed to the timer is a parameter.
  allowed(`
    function f(controller) {
      return new Promise((resolve) => {
        setTimeout(resolve, 5);
        controller.abort();
      });
    }`);
});

// The rule is only a boundary if the real workspace configs load it.
const root = fileURLToPath(new URL('../', import.meta.url));
const lintStdin = (workspace, filename, code) => {
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
    { cwd: `${root}${workspace}`, input: code, encoding: 'utf8' },
  );
  assert.equal(result.error, undefined);
  const [{ messages }] = JSON.parse(result.stdout);
  return messages.filter(({ ruleId }) => ruleId === 'internal/exchange-deadline');
};
const manualTimer =
  'export function f(c: AbortController) { return setTimeout(() => c.abort(), 5); }\n';

for (const [workspace, filename] of [
  ['services/marketplace-service', 'src/economic/probe.ts'],
  ['services/notification-service', 'src/recipients/probe.ts'],
  ['services/identity-service', 'src/audit-correction/probe.ts'],
  ['services/economic-service', 'src/provenance/probe.ts'],
  ['services/api-gateway', 'src/proxy/probe.ts'],
  ['packages/nest-common', 'src/http/probe.ts'],
]) {
  test(`real workspace ESLint refuses a manual abort timer in ${workspace}`, () => {
    const found = lintStdin(workspace, filename, manualTimer);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0].severity, 2);
  });
}

test('the shared boundary is the one file the workspace config lets keep its timer', () => {
  assert.deepEqual(
    lintStdin('packages/nest-common', 'src/http/exchange-deadline.ts', manualTimer),
    [],
  );
  // Same directory, any other file: refused.
  assert.equal(
    lintStdin('packages/nest-common', 'src/http/other-client.ts', manualTimer).length,
    1,
  );
});
