import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import exchangeDeadline, { ABORT_OWNERS, TIMER_ABORT_MODULES } from './exchange-deadline-rule.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const linter = new Linter({ cwd: root });
/** Findings of the rule alone, for `code` as the file `path` (repository-relative). */
const check = (code, { path = 'services/fixture-service/src/probe.ts' } = {}) =>
  linter.verify(
    code,
    [
      {
        files: ['**/*.{ts,tsx,mjs,js}'],
        languageOptions: { parser: tseslint.parser, sourceType: 'module' },
        plugins: { internal: { rules: { 'exchange-deadline': exchangeDeadline } } },
        rules: { 'internal/exchange-deadline': 'error' },
      },
    ],
    `${root}${path}`,
  );
/**
 * The message ids of this rule, sorted. A parse error fails here; findings of other rules
 * (the real files carry directives for rules this fixture config does not define) are not ours.
 */
const found = (code, options) => {
  const messages = check(code, options);
  assert.deepEqual(
    messages.filter(({ fatal }) => fatal),
    [],
  );
  return messages
    .filter(({ ruleId }) => ruleId === 'internal/exchange-deadline')
    .map(({ messageId }) => messageId)
    .sort();
};
const refused = (code, ...ids) => assert.deepEqual(found(code), ids.sort(), code);
const allowed = (code, options) => assert.deepEqual(found(code, options), [], code);

const CONTROLLER = 'controller';
const TIMER_ABORT = 'timerAbort';

// ---------------------------------------------------------------------------
// The shapes #502 r1 F1 found, and what #507 r1 F2 showed the old order-based rule missed.
// ---------------------------------------------------------------------------
test('refuses the reproduced shape: timer cleared once the headers arrive, body read after', () => {
  refused(
    `
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
    }`,
    CONTROLLER,
    TIMER_ABORT,
  );
});

test('refuses the unawaited return in a try/finally (the finally runs before the read settles)', () => {
  refused(
    `
    async function call(sender) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        const response = await sender.send(url, { signal: controller.signal });
        return response.text();
      } finally {
        clearTimeout(timer);
      }
    }`,
    CONTROLLER,
    TIMER_ABORT,
  );
});

test('refuses a refusal that returns without reading or cancelling the body (#507 r1 F1 shape)', () => {
  refused(
    `
    async function call(sender, controller) {
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        const response = await sender.send(url, { signal: controller.signal });
        if (response.status !== 200) throw new Error('refused');
        return await response.json();
      } finally {
        clearTimeout(timer);
      }
    }`,
    TIMER_ABORT,
  );
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
    refused(
      `
      async function call(sender, controller) {
        const timer = setTimeout(() => controller.abort(), 100);
        try {
          const response = await sender.send(url, { signal: controller.signal });
          ${reader}
        } finally {
          clearTimeout(timer);
        }
      }`,
      TIMER_ABORT,
    );
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
    refused(
      `
      function call(controller) {
        const stop = () => controller.abort();
        const timer = ${timer};
        return timer;
      }`,
      TIMER_ABORT,
    );
  });
}

// ---------------------------------------------------------------------------
// #507 r2 F2: the twelve indirections that walked round the name-following version,
// each in the two shapes a caller writes it: the controller built in the module
// (layer A and layer B both see it) and handed in as a parameter (layer B alone).
// ---------------------------------------------------------------------------
const VARIANTS = [
  // callback wrappers
  [
    'a callback wrapper',
    'const stop = () => controller.abort(); const timer = setTimeout(() => stop(), timeoutMs);',
  ],
  [
    'a wrapper function declaration',
    'function stop() { controller.abort(); } const timer = setTimeout(() => { stop(); }, timeoutMs);',
  ],
  [
    'a wrapper two calls deep',
    'const inner = () => controller.abort(); const outer = () => inner(); const timer = setTimeout(outer, timeoutMs);',
  ],
  // aliases
  [
    'an alias of the controller',
    'const handle = controller; const timer = setTimeout(() => handle.abort(), timeoutMs);',
  ],
  [
    'an alias of the method',
    'const halt = controller.abort; const timer = setTimeout(() => halt.call(controller), timeoutMs);',
  ],
  // assignments
  [
    'an assigned callback',
    'let stop; stop = () => controller.abort(); const timer = setTimeout(() => stop(), timeoutMs);',
  ],
  // object methods
  [
    'an object method',
    'const deadline = { fire() { controller.abort(); } }; const timer = setTimeout(() => deadline.fire(), timeoutMs);',
  ],
  [
    'an object method handed over as the callback',
    'const deadline = { fire: () => controller.abort() }; const timer = setTimeout(deadline.fire, timeoutMs);',
  ],
  // renamed destructured aborts
  [
    'a renamed destructured abort',
    'const { abort: halt } = controller; const timer = setTimeout(() => halt(), timeoutMs);',
  ],
  [
    'a renamed destructured abort in a parameter',
    'const arm = ({ abort: halt }) => setTimeout(() => halt(), timeoutMs); const timer = arm(controller);',
  ],
  // timer aliases
  [
    'a timer alias',
    'const later = setTimeout; const timer = later(() => controller.abort(), timeoutMs);',
  ],
  [
    'a timer alias through a function',
    'const arm = (fn) => setTimeout(fn, timeoutMs); const timer = arm(() => controller.abort());',
  ],
  // timer destructuring
  [
    'a destructured timer',
    'const { setTimeout: later } = globalThis; const timer = later(() => controller.abort(), timeoutMs);',
  ],
  [
    'a timer destructured from a required module',
    "const { setTimeout: later } = require('node:timers'); const timer = later(() => controller.abort(), timeoutMs);",
  ],
  // imported aliases
  [
    'an imported timer alias',
    'const timer = later(() => controller.abort(), timeoutMs);',
    "import { setTimeout as later } from 'node:timers';",
  ],
  [
    'a namespace-imported timer',
    'const timer = timers.setTimeout(() => controller.abort(), timeoutMs);',
    "import * as timers from 'node:timers';",
  ],
  // .call / .apply / .bind
  [
    'a timer through .call',
    'const timer = setTimeout.call(globalThis, () => controller.abort(), timeoutMs);',
  ],
  [
    'a timer through .apply',
    'const timer = setTimeout.apply(globalThis, [() => controller.abort(), timeoutMs]);',
  ],
  [
    'a timer through .bind',
    'const later = setTimeout.bind(globalThis); const timer = later(() => controller.abort(), timeoutMs);',
  ],
  // computed names
  [
    'a computed abort name',
    "const method = 'abort'; const timer = setTimeout(() => controller[method](), timeoutMs);",
  ],
  [
    'a concatenated abort name',
    "const timer = setTimeout(() => controller['ab' + 'ort'](), timeoutMs);",
  ],
  [
    'a template abort name',
    'const part = "ab"; const timer = setTimeout(() => controller[`${part}ort`](), timeoutMs);',
  ],
  [
    'a timer through an alias of the global object',
    'const root = globalThis; const timer = root.setTimeout(() => controller.abort(), timeoutMs);',
  ],
  [
    'a timer from a required module, called in place',
    "const timer = require('node:timers').setTimeout(() => controller.abort(), timeoutMs);",
  ],
  [
    'a timer from a required module, kept in a const',
    "const clock = require('node:timers'); const timer = clock.setTimeout(() => controller.abort(), timeoutMs);",
  ],
  [
    'a timer from a default import',
    'const timer = timers.setTimeout(() => controller.abort(), timeoutMs);',
    "import timers from 'timers';",
  ],
  [
    'a computed timer name',
    "const timer = globalThis['set' + 'Timeout'](() => controller.abort(), timeoutMs);",
  ],
];
const send = `
  try {
    const response = await sender.send(url, { signal: controller.signal });
    return response.text();
  } finally {
    clearTimeout(timer);
  }`;
const asParameter = (top, body) =>
  `${top}\nasync function call(sender, controller, timeoutMs) {\n${body}${send}\n}`;
const asBuilt = (top, body) =>
  `${top}\nasync function call(sender, timeoutMs) {\nconst controller = new AbortController();\n${body}${send}\n}`;

for (const [name, body, top = ''] of VARIANTS) {
  test(`#507 r2 F2: refuses ${name} (controller handed in)`, () => {
    refused(asParameter(top, body), TIMER_ABORT);
  });
  test(`#507 r2 F2: refuses ${name} (controller built here)`, () => {
    refused(asBuilt(top, body), CONTROLLER, TIMER_ABORT);
  });
}

test('the variants are the twelve classes the review named, each present', () => {
  const classes = [
    /wrapper/,
    /alias of the/,
    /assigned/,
    /object method/,
    /renamed destructured/,
    /timer alias/,
    /destructured timer|destructured from/,
    /imported timer alias|namespace-imported/,
    /\.call/,
    /\.apply/,
    /\.bind/,
    /computed|concatenated|template/,
  ];
  assert.equal(classes.length, 12);
  for (const pattern of classes) {
    assert.ok(
      VARIANTS.some(([name]) => pattern.test(name)),
      String(pattern),
    );
  }
});

// ---------------------------------------------------------------------------
// Layer A: who may hold an abort controller.
// ---------------------------------------------------------------------------
for (const [name, code] of [
  ['new AbortController()', 'const c = new AbortController(); use(c);'],
  ['an alias of the constructor', 'const AC = AbortController; const c = new AC(); use(c);'],
  ['globalThis.AbortController', 'const c = new globalThis.AbortController(); use(c);'],
  ['window.AbortController', 'const c = new window.AbortController(); use(c);'],
  ['a computed global member', "const c = new globalThis['AbortController'](); use(c);"],
  ['a concatenated global member', "const c = new globalThis['Abort' + 'Controller'](); use(c);"],
  ['Reflect.construct', 'const c = Reflect.construct(AbortController, []); use(c);'],
  [
    'a destructured global',
    'const { AbortController: AC } = globalThis; const c = new AC(); use(c);',
  ],
  [
    'an import under any name',
    "import { AbortController as AC } from 'node-abort-controller'; const c = new AC(); use(c);",
  ],
  ['a type annotation (a parameter that holds one)', 'function f(c: AbortController) { use(c); }'],
  ['a class field', 'class C { private cancel = new AbortController(); }'],
]) {
  test(`refuses an abort controller outside its owners: ${name}`, () => {
    refused(code, CONTROLLER);
  });
}

test('a controller handed to a helper elsewhere is still built here, so it is refused here', () => {
  // The timer lives in another module; the module that builds the controller is the one refused.
  refused(
    "import { armDeadline } from './arm.js'; const c = new AbortController(); armDeadline(c, 100);",
    CONTROLLER,
  );
});

test('a local binding that merely shares the name is not the global', () => {
  allowed('function f(AbortController) { return new AbortController(); }');
  allowed('const o = { AbortController: 1 }; use(o.AbortController);');
});

// ---------------------------------------------------------------------------
// What stays allowed: no deadline in sight.
// ---------------------------------------------------------------------------
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
  allowed('const both = AbortSignal.any([a, AbortSignal.timeout(100)]);');
});

test('does not flag a clearTimeout that belongs to something else (#507 r1 F2 false positive)', () => {
  allowed('async function f(response) { clearTimeout(unrelated); return await response.text(); }');
  allowed('async function f(r) { clearTimeout(t); return r.json(); }');
  allowed('class C { async m(r) { globalThis.clearTimeout(t); return r.json(); } }');
});

test('allows timers in a module that mentions no abort: sleeps, retries, shutdown bounds', () => {
  allowed('const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));');
  allowed('function f() { return new Promise((r) => { setTimeout(r, 5); }); }');
  allowed("function f(settle) { setTimeout(() => settle('abandoned'), 100); }");
  allowed('function f() { setTimeout(wake, 100); }');
  allowed('function f() { setTimeout(() => emit({ abort: true }), 100); }');
  allowed(`
    async function stopWithin(work, ms) {
      let timer;
      const bound = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
      try { await Promise.race([work(), bound]); } finally { clearTimeout(timer); }
    }`);
  allowed('function f() { const t = setTimeout(tick, 5); t.unref(); return t; }');
});

test('an abort that is only listened for, defined, or named in data is not an abort call', () => {
  allowed(`
    function wait(signal, ms) {
      return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => clearTimeout(t), { once: true });
      });
    }`);
  allowed(
    'function abort(reason) { throw new Error(reason); } setTimeout(() => abort("late"), 5);',
  );
  allowed('class Job { abort() { this.stopped = true; } } setTimeout(() => run(), 5);');
  allowed('const handlers = { abort: () => 1 }; setTimeout(() => use(handlers), 5);');
});

test("a test runner's setTimeout and a request interceptor's abort are neither timer nor controller", () => {
  // Playwright's test.setTimeout(ms) is a per-test limit; route.abort() drops an intercepted request.
  allowed(`
    test.setTimeout(240_000);
    test('x', async ({ page }) => {
      await page.route('**/*', (route) => route.abort('connectionreset'));
    });`);
  allowed('jest.setTimeout(20_000); const stop = (job) => job.abort();');
  allowed('const { setTimeout: limit } = test; limit(5); const stop = (job) => job.abort();');
  // The same names on the platform timer are a timer.
  refused('globalThis.setTimeout(wake, 5); const stop = (job) => job.abort();', TIMER_ABORT);
});

test('abort and a timer in separate modules are separate questions', () => {
  // Module one: abort, no timer. Module two: a timer, no abort. Neither pairs them.
  allowed('export const stop = (controller) => controller.abort();');
  allowed('export const arm = (fn, ms) => setTimeout(fn, ms);');
});

// ---------------------------------------------------------------------------
// Real production files: the legitimate non-HTTP timers and owners stay clean.
// ---------------------------------------------------------------------------
const READ = (path) => readFileSync(`${root}${path}`, 'utf8');
for (const path of [
  // outbox, consumer, shutdown, readiness: timers with no abort
  'packages/nest-common/src/outbox/outbox.ts',
  'packages/nest-common/src/outbox/outbox-purge.ts',
  'packages/nest-common/src/consumer/event-consumer.ts',
  'packages/nest-common/src/lifecycle/graceful-shutdown.ts',
  'packages/nest-common/src/kafka/bounded-disconnect.ts',
  'packages/nest-common/src/kafka/readiness-probe.ts',
  // the TCP deadline and the shutdown cancellations: owners, listed with a reason
  'services/document-service/src/scanning/clamav/clamd.client.ts',
  'services/identity-service/src/identity/membership-expiry.scanner.ts',
  'services/identity-service/src/identity/registration-intake.worker.ts',
  'services/identity-service/src/keycloak/keycloak-fence-sampler.ts',
  'services/identity-service/src/observability/outbox-gauges.ts',
  'services/identity-service/src/prisma/cancellation.ts',
  'services/api-gateway/src/proxy/gateway.controller.ts',
]) {
  test(`the real ${path} passes`, () => {
    allowed(READ(path), { path });
  });
}

// ---------------------------------------------------------------------------
// The allow-lists: exact files, each with a reason, none stale.
// ---------------------------------------------------------------------------
const FILE_PATTERN = /^[\w@.-]+(?:\/[\w@.[\]-]+)+\.(?:ts|tsx|mjs)$/;
const beside = (path) => path.replace(/(\.\w+)$/, '-copy$1');

for (const [label, list] of [
  ['ABORT_OWNERS', ABORT_OWNERS],
  ['TIMER_ABORT_MODULES', TIMER_ABORT_MODULES],
]) {
  test(`every ${label} entry is one existing file with a reason, never a directory`, () => {
    for (const [file, reason] of Object.entries(list)) {
      assert.match(file, FILE_PATTERN, file);
      assert.doesNotMatch(file, /[*?{}!]|\/$/, file);
      assert.ok(statSync(`${root}${file}`).isFile(), file);
      assert.ok(reason.length >= 30, `${file}: say why it may hold this`);
    }
  });
}

test('the allow-lists change only with a reviewed decision', () => {
  assert.deepEqual(Object.keys(ABORT_OWNERS).sort(), [
    'apps/web/src/lib/session-refusal.ts',
    'services/api-gateway/src/proxy/gateway.controller.ts',
    'services/document-service/src/scanning/clamav/clamd.client.ts',
    'services/identity-service/src/identity/membership-expiry.scanner.ts',
    'services/identity-service/src/identity/registration-intake.worker.ts',
    'services/identity-service/src/keycloak/keycloak-fence-sampler.ts',
    'services/identity-service/src/keycloak/keycloak-projection.consumer.ts',
    'services/identity-service/src/keycloak/keycloak.projector.ts',
    'services/identity-service/src/observability/outbox-gauges.ts',
    'services/identity-service/src/prisma/cancellation.ts',
  ]);
  assert.deepEqual(Object.keys(TIMER_ABORT_MODULES).sort(), [
    'apps/web/src/lib/session-refusal.ts',
    'scripts/ci-trivy-db-lib.mjs',
    'scripts/replay-dlq.mjs',
    'services/document-service/src/scanning/clamav/clamd.client.ts',
  ]);
});

test('an entry is exempt as that exact file only, and only from its own question', () => {
  for (const file of Object.keys(ABORT_OWNERS)) {
    // The file's own source is clean at its own path…
    const source = READ(file);
    assert.deepEqual(
      found(source, { path: file }).filter((id) => id === CONTROLLER),
      [],
      file,
    );
    // …and refused for the controller one step away from it: the entry is not a pattern.
    assert.ok(found(source, { path: beside(file) }).includes(CONTROLLER), `${file}: stale entry`);
  }
  for (const file of Object.keys(TIMER_ABORT_MODULES)) {
    const source = READ(file);
    assert.deepEqual(
      found(source, { path: file }).filter((id) => id === TIMER_ABORT),
      [],
      file,
    );
    assert.ok(found(source, { path: beside(file) }).includes(TIMER_ABORT), `${file}: stale entry`);
  }
});

test('an owner may hold a controller but not pair it with a timer unless it is listed for that', () => {
  const owner = 'services/identity-service/src/identity/membership-expiry.scanner.ts';
  assert.ok(Object.hasOwn(ABORT_OWNERS, owner));
  assert.ok(!Object.hasOwn(TIMER_ABORT_MODULES, owner));
  refused(
    'const c = new AbortController(); setTimeout(() => c.abort(), 5);',
    CONTROLLER,
    TIMER_ABORT,
  );
  assert.deepEqual(
    found('const c = new AbortController(); setTimeout(() => c.abort(), 5);', { path: owner }),
    [TIMER_ABORT],
  );
});

test('inherited names are not entries', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.ok(!Object.hasOwn(ABORT_OWNERS, name) && !Object.hasOwn(TIMER_ABORT_MODULES, name));
    allowed('export const x = 1;', { path: `services/fixture-service/src/${name}.ts` });
  }
});

// ---------------------------------------------------------------------------
// The rule is only a boundary if the real workspace configs load it.
// ---------------------------------------------------------------------------
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
/** Both questions in one file: a timer that aborts a handed-in controller, and a built one. */
const manualDeadline = [
  'export function f(c: { abort(): void }) { return setTimeout(() => c.abort(), 5); }',
  'export const built = new AbortController();',
  '',
].join('\n');

for (const [workspace, filename] of [
  ['services/marketplace-service', 'src/economic/probe.ts'],
  ['services/notification-service', 'src/recipients/probe.ts'],
  ['services/identity-service', 'src/audit-correction/probe.ts'],
  ['services/economic-service', 'src/provenance/probe.ts'],
  ['services/api-gateway', 'src/proxy/probe.ts'],
  ['services/document-service', 'src/scanning/probe.ts'],
  ['packages/nest-common', 'src/http/probe.ts'],
  ['apps/web', 'src/server/probe.ts'],
  ['tests/e2e', 'src/probe.ts'],
]) {
  test(`real workspace ESLint refuses a manual abort deadline in ${workspace}`, () => {
    const messages = lintStdin(workspace, filename, manualDeadline);
    assert.deepEqual(messages.map(({ messageId }) => messageId).sort(), [CONTROLLER, TIMER_ABORT]);
    assert.ok(messages.every(({ severity }) => severity === 2));
  });
}

test('the shared boundary is the one file the workspace config lets keep its timer', () => {
  assert.deepEqual(
    lintStdin('packages/nest-common', 'src/http/exchange-deadline.ts', manualDeadline),
    [],
  );
  // Same directory, any other file: refused.
  assert.equal(
    lintStdin('packages/nest-common', 'src/http/other-client.ts', manualDeadline).length,
    2,
  );
});

test('every workspace that lints source loads the rule (a new workspace cannot opt out silently)', async () => {
  const { ESLint } = await import('eslint');
  const workspaces = ['services', 'packages', 'apps', 'tests'].flatMap((group) =>
    readdirSync(`${root}${group}`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}`),
  );
  let checked = 0;
  for (const workspace of workspaces) {
    let config;
    try {
      statSync(`${root}${workspace}/eslint.config.mjs`);
    } catch {
      continue;
    }
    const eslint = new ESLint({ cwd: `${root}${workspace}` });
    config = await eslint.calculateConfigForFile(`${root}${workspace}/src/probe.ts`);
    assert.equal(config?.rules?.['internal/exchange-deadline']?.[0], 2, workspace);
    checked += 1;
  }
  assert.ok(checked >= 20, `only ${checked} workspaces found`);
});
