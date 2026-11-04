import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative as relativePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import exchangeDeadline, {
  ABORT_OWNERS,
  SHARED_BOUNDARY,
  TIMER_ABORT_MODULES,
  repoPath,
} from './exchange-deadline-rule.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const linter = new Linter({ cwd: root });
/** Findings of the rule alone, for `code` as the file `path` (repository-relative). */
const check = (
  code,
  { path = 'services/fixture-service/src/probe.ts', file = `${root}${path}`, using = linter } = {},
) =>
  using.verify(
    code,
    [
      {
        files: ['**/*.{ts,tsx,mts,cts,mjs,js,jsx,cjs}'],
        languageOptions: {
          parser: tseslint.parser,
          sourceType: 'module',
          parserOptions: { tsconfigRootDir: root },
        },
        plugins: { internal: { rules: { 'exchange-deadline': exchangeDeadline } } },
        rules: { 'internal/exchange-deadline': 'error' },
      },
    ],
    file,
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
const BY_NAME = 'globalByName';
/** Every file type the repository lints with this rule. */
const FILE_TYPES = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];

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
    'services/marketplace-service/src/temporal/saga.client.ts',
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
const lintStdin = (workspace, filename, code = manualDeadline) => {
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

// ---------------------------------------------------------------------------
// #536 r1 F2: the shared boundary is ONE file, identified by its exact canonical
// repository path inside the rule — not by a suffix in the workspace config.
// ---------------------------------------------------------------------------
const SHADOW_PATHS = [
  'services/identity-service/src/http/exchange-deadline.ts',
  'services/identity-service/dev/http/exchange-deadline.ts',
  'packages/config/src/http/exchange-deadline.ts',
  // the same basename around the real one: another directory, another depth, another workspace
  'packages/nest-common/dev/http/exchange-deadline.ts',
  'packages/nest-common/src/exchange-deadline.ts',
  'packages/nest-common/src/http/nested/exchange-deadline.ts',
  'packages/nest-common-copy/src/http/exchange-deadline.ts',
  'services/economic-service/prisma/http/exchange-deadline.ts',
  'tests/e2e/src/http/exchange-deadline.ts',
];

test('the shared boundary is a real file, and the rule exempts it by that path', () => {
  assert.ok(statSync(`${root}${SHARED_BOUNDARY}`).isFile());
  assert.equal(repoPath(`${root}${SHARED_BOUNDARY}`), SHARED_BOUNDARY);
  // Its own source, at its own path: clean. The same bytes one step away: both diagnostics.
  const source = READ(SHARED_BOUNDARY);
  assert.deepEqual(found(source, { path: SHARED_BOUNDARY }), []);
  assert.deepEqual(found(source, { path: beside(SHARED_BOUNDARY) }).sort(), [
    CONTROLLER,
    TIMER_ABORT,
  ]);
  // Whatever is written at that path is exempt (it is the boundary, not a pattern of content).
  assert.deepEqual(found(manualDeadline, { path: SHARED_BOUNDARY }), []);
});

for (const path of SHADOW_PATHS) {
  test(`${path}: a shadow of the boundary's name gets both diagnostics`, () => {
    assert.deepEqual(found(manualDeadline, { path }), [CONTROLLER, TIMER_ABORT]);
  });
}

test('a path the rule cannot place in this repository is exempt from nothing', () => {
  // Not on disk, outside the repository, the root itself, a directory, no file at all.
  for (const file of [
    `${root}services/identity-service/src/http/exchange-deadline.ts`,
    join(tmpdir(), SHARED_BOUNDARY),
    root,
    `${root}packages/nest-common/src/http`,
    `${root}packages/nest-common/src/http/not-there.ts`,
    '<input>',
    '<text>',
    '',
  ]) {
    assert.equal(repoPath(file), null, file);
  }
  // …and the lint decision agrees: an input the linter names `<input>.ts` is refused like any other.
  const messages = linter
    .verify(
      manualDeadline,
      [
        {
          files: ['**/*.ts'],
          languageOptions: {
            parser: tseslint.parser,
            sourceType: 'module',
            parserOptions: { tsconfigRootDir: root },
          },
          plugins: { internal: { rules: { 'exchange-deadline': exchangeDeadline } } },
          rules: { 'internal/exchange-deadline': 'error' },
        },
      ],
      '<input>.ts',
    )
    .map(({ messageId }) => messageId)
    .sort();
  assert.deepEqual(messages, [CONTROLLER, TIMER_ABORT]);
});

test('a link is its target: the boundary is the boundary under any name, and a name is not the boundary', () => {
  const dir = mkdtempSync(join(root, 'scripts', 'exdl-link-'));
  try {
    const rel = (file) => relativePath(root, file).split(sep).join('/');
    // A link elsewhere to the real boundary is the boundary's own bytes: exempt.
    const toBoundary = join(dir, 'boundary-link.ts');
    symlinkSync(`${root}${SHARED_BOUNDARY}`, toBoundary);
    assert.equal(repoPath(toBoundary), SHARED_BOUNDARY);
    assert.deepEqual(found(manualDeadline, { path: rel(toBoundary) }), []);
    // A file at a boundary-shaped path that is a link to something else is that something else.
    const other = join(dir, 'other.ts');
    writeFileSync(other, 'export {};\n');
    const shaped = join(dir, 'packages/nest-common/src/http');
    mkdirSync(shaped, { recursive: true });
    symlinkSync(other, join(shaped, 'exchange-deadline.ts'));
    const shadow = join(shaped, 'exchange-deadline.ts');
    assert.equal(repoPath(shadow), rel(other));
    assert.deepEqual(found(manualDeadline, { path: rel(shadow) }), [CONTROLLER, TIMER_ABORT]);
    // A whole directory link to the real http directory: the file under it is the real one.
    symlinkSync(`${root}packages/nest-common/src/http`, join(dir, 'http-link'));
    assert.equal(repoPath(join(dir, 'http-link/exchange-deadline.ts')), SHARED_BOUNDARY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real workspace ESLint: the config grants nothing by suffix, the real file stays clean', async () => {
  const { ESLint } = await import('eslint');
  // The rule is ON for every one of these paths, the boundary included: its exemption is inside the rule.
  for (const [cwd, path] of [
    ['', SHARED_BOUNDARY],
    ...SHADOW_PATHS.map((shadow) => ['', shadow]),
  ]) {
    const eslint = new ESLint({ cwd: `${root}${cwd}` });
    const config = await eslint.calculateConfigForFile(`${root}${path}`);
    assert.equal(config?.rules?.['internal/exchange-deadline']?.[0], 2, path);
  }
  assert.deepEqual(
    lintStdin('packages/nest-common', 'src/http/exchange-deadline.ts', manualDeadline),
    [],
  );
  assert.deepEqual(lintStdin('', SHARED_BOUNDARY, manualDeadline), []);
  const real = lintStdin(
    'packages/nest-common',
    'src/http/exchange-deadline.ts',
    READ(SHARED_BOUNDARY),
  );
  assert.deepEqual(real, []);
});

for (const path of SHADOW_PATHS) {
  test(`real workspace ESLint refuses the shadow ${path} (virtual and on disk)`, () => {
    const both = (messages) => messages.map(({ messageId }) => messageId).sort();
    // Virtual: nothing at that path (the workspace config decides by the name alone).
    assert.deepEqual(both(lintStdin('', path)), [CONTROLLER, TIMER_ABORT]);
    // On disk: a real file whose canonical path ENDS in the shadow path (so a suffix grant would
    // exempt it), inside the repository but under a scratch directory of scripts/ — never in
    // apps/, services/ or packages/, where a concurrent source sweep (testing-dev-only) would
    // see the file appear and vanish: that race turned #536 r3's first CI run red.
    const scratch = mkdtempSync(join(root, 'scripts', 'exdl-shadow-'));
    try {
      const file = join(scratch, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, manualDeadline);
      assert.equal(repoPath(file), relativePath(root, file).split(sep).join('/'));
      assert.ok(repoPath(file).endsWith(path));
      assert.deepEqual(found(manualDeadline, { file }), [CONTROLLER, TIMER_ABORT]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

test('this file writes only under scripts/exdl-* or the system temp directory, never into a swept source tree', () => {
  // The structural guard for the race above: a concurrent `node --test` file sweeps apps/,
  // services/ and packages/, so every directory this file creates is rooted in scripts/ or tmp.
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const bases = [...source.matchAll(/mkdtempSync\(\s*join\(([^)]*\)?)[,)]/g)].map(([, base]) =>
    base.replace(/\s+/g, ' ').trim(),
  );
  assert.ok(bases.length >= 3, bases.join(' | '));
  for (const base of bases) {
    assert.ok(/^(?:root, 'scripts'|tmpdir\(\)$|tmpdir\(\)\b)/.test(base), base);
  }
  // …and nothing is written or created at a `${root}…` path directly.
  assert.ok(!/(?:writeFile|mkdir)Sync\(\s*`\$\{root\}/.test(source));
});

// ---------------------------------------------------------------------------
// #536 r1 F3: every import-definition shape is read before its source is — the
// TypeScript import-equals forms have no ImportDeclaration. A crash is a failure.
// ---------------------------------------------------------------------------
test('review F3: import-equals of the timers module does not crash and is a timer host', () => {
  const alone = "import clock = require('node:timers'); clock.setTimeout(wake, 5);";
  allowed(alone);
  refused(`${alone} export const stop = (c: { abort(): void }) => c.abort();`, TIMER_ABORT);
  refused(
    "import clock = require('timers/promises'); clock.setTimeout(() => c.abort(), 5);",
    TIMER_ABORT,
  );
  // Another module is not the timers module.
  allowed("import fs = require('node:fs'); fs.setTimeout(() => c.abort(), 5);");
});

test('review F3: import-equals of the global object does not crash and is a global host', () => {
  allowed('import g = globalThis; g.setTimeout(wake, 5);');
  refused('import g = globalThis; g.setTimeout(() => c.abort(), 5);', TIMER_ABORT);
  refused('import g = globalThis; export const c = new g.AbortController();', CONTROLLER);
  refused('export import g = globalThis; g.setTimeout(() => c.abort(), 5);', TIMER_ABORT);
  refused(
    'namespace N { import g = globalThis; export const c = new g.AbortController(); }',
    CONTROLLER,
  );
  // An alias of an alias, across both import forms.
  refused(
    "import t = require('timers'); import u = t; u.setTimeout(() => c.abort(), 5);",
    TIMER_ABORT,
  );
  // The member itself, aliased by import-equals.
  refused('import t = globalThis.setTimeout; t(() => c.abort(), 5);', TIMER_ABORT);
  refused('import A = globalThis.AbortController; export type T = A;', CONTROLLER);
  // A qualified name on something that is not a host is somebody's own member.
  allowed('import t = Foo.setTimeout; export const stop = (c) => c.abort(); t(wake, 5);');
});

test('review F3: no definition type, import form or declaration kind crashes the rule', () => {
  const shapes = [
    "import timers from 'node:timers'; timers.setTimeout(wake, 5);",
    "import * as timers from 'node:timers/promises'; timers.setTimeout(wake, 5);",
    "import type timers from 'node:timers'; timers.setTimeout(wake, 5);",
    "import { setTimeout as later } from 'node:timers'; later(wake, 5);",
    "import def, * as ns from 'node:timers'; def.setTimeout(wake, 5); ns.setTimeout(wake, 5);",
    "import 'node:timers';",
    "import json from './x.json' with { type: 'json' }; json.setTimeout(wake, 5);",
    "import a = require('./x'); a.setTimeout(wake, 5);",
    'import a = B.C.D; a.setTimeout(wake, 5);',
    'import a = b; a.setTimeout(wake, 5);',
    "import type a = require('node:timers'); export type T = typeof a;",
    "export import a = require('node:timers'); a.setTimeout(wake, 5);",
    'enum E { A } E.setTimeout; class K { static setTimeout() {} } K.setTimeout(wake, 5);',
    'function fn() {} fn.setTimeout(wake, 5); export default function named() {}',
    'try { run(); } catch (e) { e.setTimeout(wake, 5); }',
    'export function f(param, { setTimeout: s }, [x] = []) { param.setTimeout(wake, 5); s(wake); }',
    'declare module "m" { import g = globalThis; } declare global { interface Window { x: 1 } }',
    'namespace N { export namespace M { export const timers = globalThis; } } N.M.timers.setTimeout(wake, 5);',
    'type T = { setTimeout(): void }; interface I { abort(): void } let v: T; v.setTimeout();',
    'declare const timers: typeof import("node:timers"); timers.setTimeout(wake, 5);',
    'const { a: { setTimeout: later }, ...rest } = globalThis; later(wake, 5); rest.setTimeout(wake, 5);',
    'let x; ({ setTimeout: x } = globalThis); x(wake, 5);',
    'export = globalThis;',
    'const a = require("node:timers"), b = await import("node:timers"); a.setTimeout(wake); b.setTimeout(wake);',
  ];
  for (const code of shapes) {
    assert.doesNotThrow(() => found(code), code);
  }
});

// ---------------------------------------------------------------------------
// #536 r1 F1 (D-095): the two plausibly-accidental forms closed; the rest pinned as residual.
// ---------------------------------------------------------------------------
test('review F1(a): a direct const alias of the global object is the global object', () => {
  for (const host of ['globalThis', 'global', 'window', 'self']) {
    refused(`const root = ${host}; export const c = new root.AbortController();`, CONTROLLER);
    refused(`const root = ${host}; export const c = new root['AbortController']();`, CONTROLLER);
  }
  // An alias of an alias; a type wrapper on the way.
  refused(
    'const a = globalThis; const b = a; export const c = new b.AbortController();',
    CONTROLLER,
  );
  refused(
    'const w = window as typeof window; export const c = new w.AbortController();',
    CONTROLLER,
  );
  refused('export const c = new (globalThis as any).AbortController();', CONTROLLER);
  refused('export const c = new (globalThis satisfies object).AbortController();', CONTROLLER);
  // The review's complete regression: before this round it received zero diagnostics.
  refused(
    `
    async function call(sender, timeoutMs) {
      const root = globalThis;
      const c = new root.AbortController();
      const timer = setTimeout(() => Reflect.get(c, 'abort').call(c), timeoutMs);
      try {
        const response = await sender.send(url, { signal: c.signal });
        return response.text();
      } finally {
        clearTimeout(timer);
      }
    }`,
    CONTROLLER,
  );
  // The timer side already followed an alias; it still does, through the same function.
  refused('const root = globalThis; root.setTimeout(() => c.abort(), 5);', TIMER_ABORT);
  // A name the module declares itself is that declaration, not the global.
  allowed('const window = [1, 2]; export const last = window[window.length - 1];');
  allowed('const self = { AbortController: 1 }; export const n = self.AbortController;');
  allowed(
    'const root = { AbortController: class {} }; export const c = new root.AbortController();',
  );
  // An owner may hold a controller, however it reaches it.
  const owner = 'services/identity-service/src/identity/membership-expiry.scanner.ts';
  allowed('const root = globalThis; export const c = new root.AbortController();', { path: owner });
});

test('review F1(b): a global member read by a name that is not a constant is refused (fail closed)', () => {
  refused('const key = pick(); export const c = new globalThis[key]();', BY_NAME);
  refused('const key = pick(); export const c = new (globalThis as any)[key]();', BY_NAME);
  refused(
    'const key = pick(); const root = globalThis; export const c = new root[key]();',
    BY_NAME,
  );
  refused('export const c = new window[`Abort${pick()}`]();', BY_NAME);
  refused('export const get = (key: string) => self[key];', BY_NAME);
  refused(
    'const key = pick(); const { [key]: C } = globalThis; export const c = new C();',
    BY_NAME,
  );
  refused('function f(key) { return global[key]; }', BY_NAME);
  refused('let key = "a"; key = pick(); export const c = globalThis[key];', BY_NAME);
  // Constants fold, so they are judged by what they say.
  refused("export const c = new globalThis['Abort' + 'Controller']();", CONTROLLER);
  refused("const k = 'AbortController'; export const c = new globalThis[k]();", CONTROLLER);
  allowed("const k = 'fetch'; export const f = globalThis[k];");
  allowed("export const f = globalThis['fetch'];");
  // A symbol or a number can be neither name (the real packages/testing/src/disclosure-guard.ts).
  allowed("export const r = (globalThis as unknown as Record<symbol, X>)[Symbol.for('jest')];");
  allowed('export const r = globalThis[Symbol.iterator]; export const s = self[Symbol("x")];');
  allowed("const key = Symbol.for('jest'); export const r = globalThis[key];");
  allowed('export const r = globalThis[0];');
  // …but a string made from one is a name again.
  refused("export const r = globalThis[String(Symbol.for('jest'))];", BY_NAME);
  refused("const Symbol = pick(); export const r = globalThis[Symbol.for('jest')];", BY_NAME);
  // Writing a global by a computed name creates nothing; a member of anything else is its own field.
  allowed('export const set = (key, value) => { globalThis[key] = value; };');
  allowed('export const get = (obj, key) => obj[key];');
  allowed('const table = {}; export const get = (key) => table[key];');
  // A local that shadows the global's name is the local.
  allowed('const window = []; export const last = (i) => window[i];');
  allowed('export function f(self, key) { return self[key]; }');
  // Same exemption as the controller question: a file that may hold a controller.
  const owner = 'services/identity-service/src/identity/membership-expiry.scanner.ts';
  allowed('const key = pick(); export const c = new globalThis[key]();', { path: owner });
});

// ---------------------------------------------------------------------------
// #536 r3 (D-098): F1(b) closed completely. ONE read/write classifier (`useOf` / `sourcesOf`)
// serves every computed-global path, and ONE key classifier (`keyKind`) serves member access and
// patterns alike.
// ---------------------------------------------------------------------------
test('review N1: the review regression (destructuring assignment of two computed globals) is refused', () => {
  const regression = `
    async function call(sender, url, controllerKey, timerKey) {
      let C, later;
      ({ [controllerKey]: C, [timerKey]: later } = globalThis);
      const c = new C();
      const timer = later(() => c.abort(), 1000);
      try {
        const response = await sender.send(url, { signal: c.signal });
        return response.text();
      } finally {
        clearTimeout(timer);
      }
    }`;
  refused(regression, BY_NAME, BY_NAME);
  // The same code in every file type the repository lints.
  for (const ext of FILE_TYPES) {
    assert.deepEqual(
      found(regression, { path: `services/fixture-service/src/probe.${ext}` }),
      [BY_NAME, BY_NAME],
      ext,
    );
  }
});

// Every context in which a computed global's VALUE is taken, one diagnostic each.
const READS = {
  'plain read': 'export const c = globalThis[k];',
  'call of it': 'globalThis[k]();',
  'new of it': 'export const c = new globalThis[k]();',
  'member of it': 'export const n = globalThis[k].name;',
  'write to a member of it': 'globalThis[k].x = 1;',
  'typeof it': 'export const t = typeof globalThis[k];',
  'type-wrapped read': 'export const c = (globalThis as any)[k];',
  'optional read': 'export const c = globalThis?.[k];',
  'through a const alias': 'const root = globalThis; export const c = root[k];',
  increment: 'globalThis[k]++;',
  decrement: '--globalThis[k];',
  'computed key inside a destructuring target': '({ [globalThis[k]]: x } = o);',
  'default value of a target': '({ a: x = globalThis[k] } = o);',
  'right side of a write': 'globalThis[j] = globalThis[k];',
  'argument of delete': 'delete globalThis[globalThis[k]];',
};
for (const operator of [
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '<<=',
  '>>=',
  '>>>=',
  '&=',
  '|=',
  '^=',
  '&&=',
  '||=',
  '??=',
]) {
  READS[`compound assignment ${operator}`] = `globalThis[k] ${operator} v;`;
  READS[`type-wrapped compound ${operator}`] = `(globalThis as any)[k] ${operator} v;`;
}
Object.assign(READS, {
  // Destructuring declarations.
  declaration: 'const { [k]: C } = globalThis; export { C };',
  'declaration with a default': 'const { [k]: C = D } = globalThis; export { C };',
  'declaration through an alias': 'const g = globalThis; const { [k]: C } = g; export { C };',
  'declaration, type-wrapped source': 'const { [k]: C } = globalThis as any; export { C };',
  'declaration, rest beside it': 'const { [k]: C, ...rest } = globalThis; export { C, rest };',
  // Destructuring assignments, every nesting.
  'assignment pattern': 'let C; ({ [k]: C } = globalThis);',
  'assignment pattern with a default': 'let C; ({ [k]: C = D } = globalThis);',
  'assignment pattern, two keys': 'let C, T; ({ [a]: C, [b]: T } = globalThis);',
  'assignment pattern through an alias': 'const g = window; let C; ({ [k]: C } = g);',
  'chained assignment': 'let C, o; o = { [k]: C } = globalThis;',
  'nested in an object source': 'let C; ({ a: { [k]: C } } = { a: globalThis });',
  'nested in an array source': 'let C; ([{ [k]: C }] = [globalThis]);',
  'nested, second element': 'let C; ([x, { [k]: C }] = [1, globalThis]);',
  'defaulted pattern fed by an outer array':
    'const [{ [k]: C } = {}] = [globalThis]; export { C };',
  'defaulted pattern fed by an outer object':
    'let C; ({ a: { [k]: C } = {} } = { a: globalThis });',
  'type-wrapped literal source': 'let C; ([{ [k]: C }] = [globalThis] as const);',
  'type-wrapped object source': 'const { a: { [k]: C } } = { a: globalThis } as any; export { C };',
  'nested, behind a spread': 'let C; ([x, { [k]: C }] = [...xs, globalThis]);',
  'nested, behind a spread, position shifted': 'let C; ([x, y, { [k]: C }] = [...xs, globalThis]);',
  'declaration, array source': 'const [{ [k]: C }] = [globalThis]; export { C };',
  'declaration, object source': 'const { a: { [k]: C } } = { a: globalThis }; export { C };',
  'declaration, container held by a const':
    'const box = { g: globalThis }; const { g: { [k]: C } } = box; export { C };',
  // Defaults: parameters and values inside patterns.
  'function parameter defaulting to the global':
    'export function f({ [k]: C } = globalThis) { return C; }',
  'arrow parameter defaulting to the global': 'export const f = ({ [k]: C } = globalThis) => C;',
  'async arrow parameter': 'export const f = async ({ [k]: C } = window) => C;',
  'method parameter': 'class A { m({ [k]: C } = self) { return C; } }',
  'second parameter': 'export function f(a, { [k]: C } = globalThis) { return C; }',
  'default of a nested declaration pattern':
    'const { a: { [k]: C } = globalThis } = {}; export { C };',
  'default of an array element': 'let C; ([{ [k]: C } = globalThis] = []);',
  'default of an element in a declaration': 'const [{ [k]: C } = globalThis] = []; export { C };',
  'default of an assignment-pattern property': 'let C; ({ a: { [k]: C } = globalThis } = {});',
  // for…of heads.
  'for-of declaration head': 'for (const { [k]: C } of [globalThis]) use(C);',
  'for-of assignment head': 'let C; for ({ [k]: C } of [globalThis]) use(C);',
});
test('review N1: every context that takes the value of a computed global is refused', () => {
  for (const [label, code] of Object.entries(READS)) {
    assert.ok(found(code).includes(BY_NAME), `${label}: ${code}`);
  }
  // …and the same read is allowed where a controller may be held.
  const owner = 'services/identity-service/src/identity/membership-expiry.scanner.ts';
  allowed('globalThis[k] ??= v; const { [j]: C } = globalThis;', { path: owner });
});

// Every context that only REPLACES or REMOVES the slot: no value is read, no diagnostic.
const WRITES = {
  'plain assignment': 'globalThis[k] = v;',
  'assignment through an alias': 'const root = globalThis; root[k] = v;',
  'assignment, type-wrapped object': '(globalThis as any)[k] = v;',
  'assignment, type-wrapped target': '(globalThis[k] as any) = v;',
  'assignment, non-null target': 'globalThis[k]! = v;',
  'assignment, satisfies target': '(globalThis[k] satisfies unknown) = v;',
  'assignment, angle-bracket target': '(<any>globalThis[k]) = v;',
  'chained plain assignment': 'globalThis[a] = globalThis[b] = v;',
  'array destructuring target': '[globalThis[k]] = xs;',
  'array destructuring target, second': '[a, globalThis[k]] = xs;',
  'array destructuring target, default': '[globalThis[k] = 1] = xs;',
  'array destructuring rest target': '[...globalThis[k]] = xs;',
  'object destructuring target': '({ a: globalThis[k] } = o);',
  'object destructuring target, default': '({ a: globalThis[k] = 1 } = o);',
  'object destructuring rest target': '({ ...globalThis[k] } = o);',
  'nested destructuring target': '({ a: [globalThis[k]] } = o);',
  'nested destructuring target, wrapped': '[(globalThis[k] as any)] = xs;',
  'for-in target': 'for (globalThis[k] in o);',
  'for-of target': 'for (globalThis[k] of xs);',
  'for-of destructuring target': 'for ([globalThis[k]] of xs);',
  'for-of object destructuring target': 'for ({ a: globalThis[k] } of xs);',
  delete: 'delete globalThis[k];',
  'delete, type-wrapped': 'delete (globalThis as any)[k];',
  'delete through an alias': 'const root = window; delete root[k];',
  // A pattern whose source is not the global object reads something else.
  'pattern over another value': 'const { [k]: C } = other; export { C };',
  'assignment pattern over another value': 'let C; ({ [k]: C } = other);',
  'for-of head over another value': 'for (const { [k]: C } of [other]) use(C);',
  'pattern over a literal': 'const { [k]: C } = { a: 1 }; export { C };',
  'pattern over a platform object': 'const { [k]: C } = process.env; export { C };',
  'pattern over a local function': 'function f() {} const { [k]: C } = f; export { C };',
  'pattern over an enum': 'enum E { A } const { [k]: C } = E; export { C };',
  'for-in head (string keys)': 'for (const { [k]: C } in globalThis) use(C);',
  'nested, global in a different slot': 'let C; ({ b: { [k]: C } } = { a: globalThis, b: other });',
  'array, global in a different slot': 'let C; ([{ [k]: C }, x] = [other, globalThis]);',
  'a local named like the global':
    'const globalThis = {}; const { [k]: C } = globalThis; export { C };',
};
test('review N1: a pure write of a computed global is not a read (the review’s false positives)', () => {
  for (const [label, code] of Object.entries(WRITES)) {
    assert.deepEqual(found(code), [], `${label}: ${code}`);
  }
});

test('review N1: a write that also reads is a read, and the write beside a read keeps its one diagnostic', () => {
  // Left is a pure write, the right side is a read: exactly one diagnostic.
  refused('globalThis[a] = globalThis[b];', BY_NAME);
  // A destructuring target does not hide a read in the SOURCE of the same statement.
  refused('let x; ({ a: globalThis[k] } = { a: globalThis[j] });', BY_NAME);
  // The pattern's own key reads even when its value target is a write.
  refused('({ [k]: globalThis[j] } = globalThis);', BY_NAME);
});

// A computed key that is provably a number, a bigint or a symbol names neither the controller nor
// the timer; anything not provable could, and fails closed.
/** The spec's numeric function members of `Math` (ES2025 + f16round, sumPrecise) — FU-001. */
const FU001_MATH_FUNCTIONS = [
  'abs',
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atan2',
  'atanh',
  'cbrt',
  'ceil',
  'clz32',
  'cos',
  'cosh',
  'exp',
  'expm1',
  'f16round',
  'floor',
  'fround',
  'hypot',
  'imul',
  'log',
  'log10',
  'log1p',
  'log2',
  'max',
  'min',
  'pow',
  'random',
  'round',
  'sign',
  'sin',
  'sinh',
  'sqrt',
  'sumPrecise',
  'tan',
  'tanh',
  'trunc',
];
const FU001_WELL_KNOWN_SYMBOLS = [
  'asyncDispose',
  'asyncIterator',
  'dispose',
  'hasInstance',
  'isConcatSpreadable',
  'iterator',
  'match',
  'matchAll',
  'metadata',
  'replace',
  'search',
  'species',
  'split',
  'toPrimitive',
  'toStringTag',
  'unscopables',
];
/**
 * Calls/members of `Math` and `Symbol` that are NOT numbers / symbols (FU-001): each could
 * be or build a name (`Math.constructor('AbortController')` is a String object whose key is
 * that name), so each is refused.
 */
const FU001_NOT_PROVEN = {
  'Math.toString()': 'Math.toString()',
  'Math.toLocaleString()': 'Math.toLocaleString()',
  'Math.valueOf()': 'Math.valueOf()',
  'Math.constructor builds the name': 'Math.constructor("AbortController")',
  'Math.hasOwnProperty()': 'Math.hasOwnProperty(x)',
  'Math.propertyIsEnumerable()': 'Math.propertyIsEnumerable(x)',
  'Math.isPrototypeOf()': 'Math.isPrototypeOf(x)',
  'Math.__lookupGetter__()': 'Math.__lookupGetter__(x)',
  'an unknown Math member': 'Math.notAFunction(x)',
  'Symbol.name is a string': 'Symbol.name',
  'Symbol.for, not called': 'Symbol.for',
  'Symbol.keyFor, not called': 'Symbol.keyFor',
  'Symbol.prototype': 'Symbol.prototype',
  'Symbol.constructor': 'Symbol.constructor',
  'Symbol.length': 'Symbol.length',
  'an unknown Symbol member': 'Symbol.notWellKnown',
};
const NOT_NAMES = {
  zero: '0',
  'negative literal': '-1',
  'positive literal': '+1',
  'bitwise not': '~1',
  'sum of literals': '1 + 2',
  difference: '1 - 2',
  product: '2 * 3',
  quotient: '6 / 3',
  remainder: '7 % 3',
  power: '2 ** 3',
  shift: '1 << 2',
  'unsigned shift': '-1 >>> 0',
  'bit or': '1 | 2',
  'bit and': '3 & 1',
  'bit xor': '3 ^ 1',
  'nested arithmetic': '(1 + 2) * -(3 - 4)',
  'bigint literal': '1n',
  'negative bigint': '-1n',
  'bigint arithmetic': '1n + 2n',
  NaN: 'NaN',
  Infinity: 'Infinity',
  'negative Infinity': '-Infinity',
  'Number of anything': 'Number(x)',
  'Number of a string': 'Number("1")',
  'BigInt of anything': 'BigInt(x)',
  'Number plus a literal': 'Number(x) + 1',
  'literal times Number': '2 * Number(x)',
  'type-wrapped Number callee': '(Number as any)(x)',
  'non-null Number callee': 'Number!(x)',
  'unary minus of Number': '-Number(x)',
  'Math function call': 'Math.floor(x)',
  'Math.random': 'Math.random()',
  'Math.max of strings': 'Math.max("a", "b")',
  'Math constant': 'Math.PI',
  'Number constant': 'Number.MAX_SAFE_INTEGER',
  'Number.parseInt': 'Number.parseInt(x)',
  'Number.parseFloat': 'Number.parseFloat(x, 10)',
  'type-wrapped Math call': '(Math as any).floor(x)',
  'Math arithmetic': 'Math.floor(x) + Math.PI * 2',
  'type-wrapped numeric': '(1 + 2) as number',
  'non-null numeric': 'Number(x)!',
  'conditional of numerics': 'c ? 1 : -2',
  symbol: 'Symbol("x")',
  'symbol.for': 'Symbol.for("x")',
  'well-known symbol': 'Symbol.iterator',
  'conditional of symbols': 'c ? Symbol.iterator : Symbol.asyncIterator',
  // FU-001: every numeric function member of `Math`, every well-known symbol.
  ...Object.fromEntries(FU001_MATH_FUNCTIONS.map((f) => [`Math.${f}`, `Math.${f}(x)`])),
  ...Object.fromEntries(FU001_WELL_KNOWN_SYMBOLS.map((w) => [`Symbol.${w}`, `Symbol.${w}`])),
};
// Aliases: a constant holding a provable key inherits it.
const NOT_NAME_ALIASES = {
  'constant literal': 'const n = -1;',
  'constant arithmetic': 'const n = 1 + 2;',
  'constant of a constant': 'const m = 4; const n = m * 2;',
  'constant Number': 'const n = Number(x);',
  'constant NaN': 'const n = NaN;',
  'constant symbol': 'const n = Symbol.for("x");',
  'let never reassigned': 'let n = 1;',
};
// Not provable: each could be (or build) the name, so each fails closed.
const MAY_BE_NAMES = {
  'unknown operand of arithmetic': 'x - 1',
  'unknown operand of unary minus': '-x',
  'unknown plus a literal': 'x + 1',
  'literal plus unknown': '1 + x',
  'literal times unknown': '2 * x',
  'bitwise with an unknown right operand': '1 | x',
  'string plus a number': '"Abort" + 1',
  'unknown call': 'pick()',
  'String of a number': 'String(1)',
  'template with a number': '`${1}`',
  'a parameter': 'x',
  'the Number function itself': 'Number',
  'Math function member, not called': 'Math.floor',
  'Math member that is no constant': 'Math.abs',
  'Number.isInteger is a boolean': 'Number.isInteger(x)',
  'Number function member': 'Number.isNaN',
  'computed Math member': 'Math[x]',
  'computed Math call': 'Math[x](1)',
  'a call on another object': 'Reflect.floor(x)',
  typeof: 'typeof 1',
  comparison: '1 < 2',
  void: 'void 0',
  undefined: 'undefined',
  sequence: '(0, x)',
  'conditional with an unknown branch': 'c ? 1 : x',
  'a mixed conditional with a string': 'c ? 1 : "AbortController"',
  'logical not': '!1',
  'logical not of a variable': '!x',
  'Symbol description': 'Symbol("x").description',
  'symbol key description': 'Symbol.keyFor(s)',
  ...FU001_NOT_PROVEN,
};
const MAY_BE_NAME_ALIASES = {
  'let reassigned': 'let n = 1; n = pick();',
  'let reassigned in a function': 'let n = 1; const set = () => { n = pick(); };',
  'constant of an unknown': 'const n = pick();',
  'constant of an unknown operand': 'const n = x - 1;',
  'a for-of variable': 'const xs = []; for (const n of xs) { use(n); }',
};
// The same key, in each position that classifies a computed global.
const KEY_POSITIONS = {
  'member read': (key, prelude) => `${prelude} export const v = globalThis[${key}];`,
  'member read through a const alias': (key, prelude) =>
    `${prelude} const g = globalThis; export const v = g[${key}];`,
  'member read, compound assignment': (key, prelude) => `${prelude} globalThis[${key}] ||= v;`,
  'member read, call': (key, prelude) => `${prelude} globalThis[${key}]();`,
  'declaration pattern': (key, prelude) =>
    `${prelude} const { [${key}]: C } = globalThis; export { C };`,
  'assignment pattern': (key, prelude) => `${prelude} let C; ({ [${key}]: C } = globalThis);`,
  'parameter default pattern': (key, prelude) =>
    `${prelude} export function f({ [${key}]: C } = globalThis) { return C; }`,
  'for-of head pattern': (key, prelude) =>
    `${prelude} for (const { [${key}]: C } of [globalThis]) use(C);`,
};
test('review N2: a key that is provably a number, a bigint or a symbol names no global — in every position', () => {
  for (const [position, build] of Object.entries(KEY_POSITIONS)) {
    for (const [label, key] of Object.entries(NOT_NAMES)) {
      assert.deepEqual(found(build(key, '')), [], `${position} / ${label}: ${build(key, '')}`);
    }
    for (const [label, prelude] of Object.entries(NOT_NAME_ALIASES)) {
      assert.deepEqual(
        found(build('n', prelude)),
        [],
        `${position} / ${label}: ${build('n', prelude)}`,
      );
    }
  }
});
test('review N2: a key that is not provably a number or a symbol could be the name, so it is refused — in every position', () => {
  for (const [position, build] of Object.entries(KEY_POSITIONS)) {
    for (const [label, key] of Object.entries(MAY_BE_NAMES)) {
      assert.ok(
        found(build(key, '')).includes(BY_NAME),
        `${position} / ${label}: ${build(key, '')}`,
      );
    }
    for (const [label, prelude] of Object.entries(MAY_BE_NAME_ALIASES)) {
      assert.ok(
        found(build('n', prelude)).includes(BY_NAME),
        `${position} / ${label}: ${build('n', prelude)}`,
      );
    }
  }
});

test('review N2: Number, BigInt, NaN, Infinity and Symbol count only as the unshadowed globals', () => {
  const shadows = {
    'parameter Number': (key) => `export function f(Number, x) { return globalThis[${key}]; }`,
    'local Number': (key) => `const Number = pick(); export const v = globalThis[${key}];`,
    'imported Number': (key) =>
      `import { Number } from "./n"; export const v = globalThis[${key}];`,
    'class Number': (key) => `class Number {} export const v = globalThis[${key}];`,
    'function Number': (key) => `function Number() {} export const v = globalThis[${key}];`,
    'inner-scope Number': (key) =>
      `export function f(x) { const Number = pick; return globalThis[${key}]; }`,
    'local BigInt': (key) => `const BigInt = pick(); export const v = globalThis[${key}];`,
    'local NaN': (key) => `const NaN = pick(); export const v = globalThis[${key}];`,
    'parameter Infinity': (key) => `export function f(Infinity) { return globalThis[${key}]; }`,
    'local Symbol': (key) => `const Symbol = pick(); export const v = globalThis[${key}];`,
    'local Math': (key) => `const Math = pick(); export const v = globalThis[${key}];`,
    'parameter Math': (key) => `export function f(Math, x) { return globalThis[${key}]; }`,
    'local Number (static)': (key) => `const Number = pick(); export const v = globalThis[${key}];`,
  };
  const keys = {
    'parameter Number': 'Number(x)',
    'local Number': 'Number(x)',
    'imported Number': 'Number(x)',
    'class Number': 'Number(x)',
    'function Number': 'Number(x)',
    'inner-scope Number': 'Number(x)',
    'local BigInt': 'BigInt(x)',
    'local NaN': 'NaN',
    'parameter Infinity': 'Infinity',
    'local Symbol': 'Symbol.for("x")',
    'local Math': 'Math.floor(x)',
    'parameter Math': 'Math.PI',
    'local Number (static)': 'Number.parseInt(x)',
  };
  for (const [label, build] of Object.entries(shadows)) {
    refused(build(keys[label]), BY_NAME);
    // The same shadow in a pattern.
    const pattern = build(keys[label]).replace(/globalThis\[(.*)\];/, 'globalThis[$1]; ');
    assert.ok(found(pattern).includes(BY_NAME), label);
  }
  // A shadowed name in the pattern position, with the key written in the pattern.
  refused(
    'export function f(Number, x) { const { [Number(x)]: C } = globalThis; return C; }',
    BY_NAME,
  );
  refused('const NaN = pick(); let C; ({ [NaN]: C } = globalThis);', BY_NAME);
  // The shadow is local: the unshadowed global in another scope still proves a number.
  allowed(
    'export function f(Number, x) { return Number(x); } export const v = globalThis[Number("1")];',
  );
  // Constant aliases of a shadowed name do not prove it either.
  refused('const Number = pick(); const n = Number(x); export const v = globalThis[n];', BY_NAME);
});

test('review N1/N2: the class sweep — every file type, every global-object name', () => {
  const sources = [
    'const { [k]: C } = HOST; export { C };',
    'let C; ({ [k]: C } = HOST);',
    'HOST[k] ??= v;',
    'export function f({ [k]: C } = HOST) { return C; }',
  ];
  for (const host of ['globalThis', 'global', 'window', 'self']) {
    for (const source of sources) {
      const code = source.replaceAll('HOST', host);
      for (const ext of FILE_TYPES) {
        assert.deepEqual(
          found(code, { path: `services/fixture-service/src/probe.${ext}` }),
          [BY_NAME],
          `${ext}: ${code}`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// #536 r4 N1: ONE resolver (`valuesOf` for an expression, `targetValues` for a destructuring
// target, each in terms of the other) says what a pattern is handed and what a member's object
// is. The reviewer's three snippets, and then every family of the class in every host.
// ---------------------------------------------------------------------------
const R4_SNIPPETS = {
  'chained assignment source': '({ [ck]: C, [tk]: later } = g = globalThis);',
  'object pattern over a literal array': '({ 0: { [ck]: C, [tk]: later } } = [globalThis]);',
  'rest element of an array pattern': '([...[{ [ck]: C, [tk]: later }]] = [globalThis]);',
};
test('review r4 N1: the reviewer’s three extractions are refused — twice each, in every file type', () => {
  for (const [label, statement] of Object.entries(R4_SNIPPETS)) {
    const code = `
      export async function call(sender, url, ck, tk) {
        let C, later, g;
        ${statement}
        const c = new C();
        const timer = later(() => c.abort(), 1000);
        try {
          const response = await sender.send(url, { signal: c.signal });
          return response.text();
        } finally {
          clearTimeout(timer);
        }
      }`;
    for (const ext of FILE_TYPES) {
      assert.deepEqual(
        found(code, { path: `services/fixture-service/src/probe.${ext}` }),
        [BY_NAME, BY_NAME],
        `${label} / ${ext}`,
      );
    }
  }
});

const INNER = '{ [k]: C }';
/** pattern: what is written on the left; source: the value on the right, which holds the global (or not). */
const R4_FAMILIES = {
  // (a) the value of an assignment, a sequence, a conditional, a logical expression
  'chained assignment': { pattern: INNER, source: 'g = globalThis' },
  'chained twice': { pattern: INNER, source: 'h = g = globalThis' },
  'chained logical assignment': { pattern: INNER, source: 'g ||= globalThis' },
  'chained, type-wrapped': { pattern: INNER, source: '(g = globalThis) as any' },
  sequence: { pattern: INNER, source: '(0, globalThis)' },
  conditional: { pattern: INNER, source: 'c ? globalThis : other' },
  'conditional, global in the alternate': { pattern: INNER, source: 'c ? other : globalThis' },
  logical: { pattern: INNER, source: 'globalThis ?? other' },
  'logical, global on the right': { pattern: INNER, source: 'other ?? globalThis' },
  'chain inside a literal': { pattern: `{ a: ${INNER} }`, source: '{ a: g = globalThis }' },
  // (b) an object pattern over a literal array
  'object pattern over a literal array': { pattern: `{ 0: ${INNER} }`, source: '[globalThis]' },
  'object pattern, quoted index': { pattern: `{ '0': ${INNER} }`, source: '[globalThis]' },
  'object pattern, computed index': { pattern: `{ [0]: ${INNER} }`, source: '[globalThis]' },
  'object pattern over a spread of a literal': {
    pattern: `{ a: ${INNER} }`,
    source: '{ ...{ a: globalThis } }',
  },
  'object pattern, second element': {
    pattern: `{ 1: ${INNER} }`,
    source: '[other, globalThis]',
  },
  'object pattern, array in an object': {
    pattern: `{ a: { 0: ${INNER} } }`,
    source: '{ a: [globalThis] }',
  },
  'object pattern, object in an array': {
    pattern: `{ 0: { a: ${INNER} } }`,
    source: '[{ a: globalThis }]',
  },
  'object pattern over a chained array': {
    pattern: `{ 0: ${INNER} }`,
    source: 'xs = [globalThis]',
  },
  // (c) RestElement inside an array pattern
  'array rest': { pattern: `[...[${INNER}]]`, source: '[globalThis]' },
  'array rest after an element': { pattern: `[a, ...[${INNER}]]`, source: '[other, globalThis]' },
  'array rest, second slot': { pattern: `[...[x, ${INNER}]]`, source: '[other, globalThis]' },
  'object pattern over a rest': { pattern: `[...{ 0: ${INNER} }]`, source: '[globalThis]' },
  'rest of a rest': { pattern: `[...[...[${INNER}]]]`, source: '[globalThis]' },
  'rest over a chained array': { pattern: `[...[${INNER}]]`, source: 'xs = [globalThis]' },
  'rest over a spread array': { pattern: `[...[${INNER}]]`, source: '[...[globalThis]]' },
  'rest in a nested position': { pattern: `{ a: [...[${INNER}]] }`, source: '{ a: [globalThis] }' },
  // the same reach through the values a literal holds
  'spread copy of the global': { pattern: INNER, source: '{ ...globalThis }' },
  'global member of the global': { pattern: INNER, source: 'globalThis.global' },
  // (d) what the resolver cannot prove is not the global object
  'call result': { pattern: INNER, source: 'getGlobal()' },
  'handed-in value': { pattern: INNER, source: 'handed' },
};
const R4_HOSTS = {
  declaration: (p, s) => `const ${p} = ${s}; export { C };`,
  assignment: (p, s) => `let C; (${p} = ${s});`,
  'function parameter default': (p, s) => `export function f(${p} = ${s}) { return C; }`,
  'arrow parameter default': (p, s) => `export const f = (${p} = ${s}) => C;`,
  'default inside an array pattern': (p, s) => `let C; ([${p} = ${s}] = []);`,
  'default inside an object pattern': (p, s) => `let C; ({ a: ${p} = ${s} } = {});`,
  'for-of declaration head': (p, s) => `for (const ${p} of [${s}]) use(C);`,
  'for-of assignment head': (p, s) => `let C; for (${p} of [${s}]) use(C);`,
};
test('review r4 N1: every family of the class, in every host, in every file type', () => {
  // `handed` is a parameter in the "handed-in value" family.
  const prelude = (label) => (label === 'handed-in value' ? 'declare const handed: unknown; ' : '');
  for (const [family, { pattern, source }] of Object.entries(R4_FAMILIES)) {
    for (const [host, build] of Object.entries(R4_HOSTS)) {
      const code = prelude(family) + build(pattern, source);
      for (const ext of FILE_TYPES) {
        // `declare` is TypeScript only; the other families are plain JavaScript.
        if (family === 'handed-in value' && !/^(ts|tsx|mts|cts)$/.test(ext)) continue;
        assert.deepEqual(
          found(code, { path: `services/fixture-service/src/probe.${ext}` }),
          [BY_NAME],
          `${family} / ${host} / ${ext}: ${code}`,
        );
      }
    }
  }
});

test('review r4 N1: an object pattern with a key nobody can read takes any element of a literal array', () => {
  // The outer key is itself computed, so a host that hands the outer pattern in reports it too.
  for (const [host, build] of Object.entries(R4_HOSTS)) {
    const code = build(`{ [x]: ${INNER} }`, '[globalThis]');
    assert.ok(found(code).includes(BY_NAME), `${host}: ${code}`);
  }
  refused(`const { [x]: ${INNER} } = [globalThis]; export { C };`, BY_NAME);
});

// A parameter's default does not prove the parameter: the caller may pass anything. The hosts
// below are the ones whose value is fully on the page.
const R4_PROVEN_HOSTS = Object.fromEntries(
  Object.entries(R4_HOSTS).filter(([host]) => !host.endsWith('parameter default')),
);

// Precision: the same shapes, where the slot the pattern reads holds something provably else.
const R4_OTHER = {
  'chained assignment of another value': { pattern: INNER, source: 'g = other' },
  'sequence ending in another value': { pattern: INNER, source: '(globalThis, other)' },
  'conditional of other values': { pattern: INNER, source: 'c ? other : { a: 1 }' },
  'object pattern reading the other slot': {
    pattern: `{ 0: ${INNER} }`,
    source: '[other, globalThis]',
  },
  'object pattern past the end of the array': {
    pattern: `{ 1: ${INNER} }`,
    source: '[globalThis]',
  },
  'object pattern, array method name': { pattern: `{ length: ${INNER} }`, source: '[globalThis]' },
  'array rest starts after the global': {
    pattern: `[a, ...[${INNER}]]`,
    source: '[globalThis, other]',
  },
  'array rest, second slot reads the other': {
    pattern: `[...[${INNER}, x]]`,
    source: '[other, globalThis]',
  },
  'rest of a rest, past the global': {
    pattern: `[a, ...[b, ...[${INNER}]]]`,
    source: '[globalThis, globalThis, other]',
  },
  'nested, another slot': { pattern: `{ b: ${INNER} }`, source: '{ a: globalThis, b: other }' },
  'a member of the global that is not a global object': {
    pattern: INNER,
    source: 'globalThis.process',
  },
  'a spread copy of another value': { pattern: INNER, source: '{ ...other }' },
  'a spread of a literal whose member is another value': {
    pattern: `{ a: ${INNER} }`,
    source: '{ ...{ a: other }, b: globalThis }',
  },
  'a spread array of another value': { pattern: `[...[${INNER}]]`, source: '[...[other]]' },
  'computed index reads the other slot': {
    pattern: `{ [0]: ${INNER} }`,
    source: '[other, globalThis]',
  },
  'conditional, both other': { pattern: INNER, source: 'c ? other : 1' },
  'logical, both other': { pattern: INNER, source: 'other ?? 1' },
  'a literal': { pattern: INNER, source: '{ a: 1 }' },
};
test('review r4 N1: a slot that provably holds something else is not refused — the closure is not a blanket', () => {
  for (const [family, { pattern, source }] of Object.entries(R4_OTHER)) {
    for (const [host, build] of Object.entries(R4_PROVEN_HOSTS)) {
      assert.deepEqual(found(build(pattern, source)), [], `${family} / ${host}`);
    }
  }
});

// Expressions: the member's OBJECT is resolved by the same function.
const R4_OBJECTS = {
  'literal member': 'const box = { g: globalThis }; export const v = box.g[k];',
  'literal member, quoted': 'const box = { g: globalThis }; export const v = box["g"][k];',
  'literal array element': 'const list = [globalThis]; export const v = list[0][k];',
  'destructured from a literal':
    'const box = { g: globalThis }; const { g } = box; export const v = g[k];',
  'destructured from an array': 'const [g] = [globalThis]; export const v = g[k];',
  'object rest of the global': 'const { a, ...rest } = globalThis; export const v = rest[k];',
  'alias assigned through a type assertion':
    'let g: any; (g as any) = globalThis; export const v = g[k];',
  'alias assigned through a non-null target': 'let g: any; g! = globalThis; export const v = g[k];',
  'array rest alias': 'const [...[g]] = [globalThis]; export const v = g[k];',
  'alias made by assignment': 'let g; g = globalThis; export const v = g[k];',
  'alias reassigned from another value': 'let g = other; g = globalThis; export const v = g[k];',
  'alias through a compound chain': 'let g, h; h = g = globalThis; export const v = h[k];',
  'alias through a logical assignment': 'let g; g ||= globalThis; export const v = g[k];',
  'parameter that defaults to the global': 'export function f(g = globalThis) { return g[k]; }',
  'object pattern parameter that defaults':
    'export function f({ g } = { g: globalThis }) { return g[k]; }',
  'inside a conditional': 'export const v = (c ? globalThis : other)[k];',
  'inside a logical expression': 'export const v = (globalThis ?? other)[k];',
  'after a sequence': 'export const v = (0, globalThis)[k];',
  'an assignment expression': 'let g; export const v = (g = globalThis)[k];',
  'type-wrapped alias': 'const g = globalThis as any; export const v = g![k];',
  'member of the global': 'export const v = globalThis.global[k];',
  'self member': 'export const v = globalThis.self[k];',
  'destructured global member': 'const { global: g } = globalThis; export const v = g[k];',
  'spread copy': 'export const v = ({ ...globalThis })[k];',
  'for-of element': 'for (const g of [globalThis]) use(g[k]);',
  'alias of an alias': 'const a = globalThis; const b = a; const c = b; export const v = c[k];',
};
// Patterns over values that are provably not the global object, by their kind alone.
const R4_PROVEN_PATTERNS = {
  counter: 'let n = 0; n++; n += 2; const { [k]: C } = n; export { C };',
  'compound string': 'let s = "a"; s += "b"; const { [k]: C } = s; export { C };',
  'for-in key': 'for (const key in obj) { const { [k]: C } = key; use(C); }',
  'for-in assignment head': 'let C; for ({ [k]: C } in obj) use(C);',
  'for-in declaration head': 'for (const { [k]: C } in obj) use(C);',
  'template literal': 'const { [k]: C } = `x${y}`; export { C };',
  negation: 'const { [k]: C } = !flag; export { C };',
  'arrow function': 'const { [k]: C } = () => 1; export { C };',
  'class expression': 'const { [k]: C } = class {}; export { C };',
  'class declaration': 'class K {} const { [k]: C } = K; export { C };',
  'platform namespace': 'const { [k]: C } = JSON; export { C };',
  'logical assignment of other values': 'let s = 1; s ||= 2; const { [k]: C } = s; export { C };',
};
test('review r4 N1: a pattern over a value of a kind that is never the global object is not refused', () => {
  for (const [label, code] of Object.entries(R4_PROVEN_PATTERNS)) {
    assert.deepEqual(found(code), [], `${label}: ${code}`);
  }
});

const R4_OBJECTS_OTHER = {
  'literal member of another value': 'const box = { g: other }; export const v = box.g[k];',
  'other array element': 'const list = [globalThis]; export const v = list[1][k];',
  'array length': 'const list = [globalThis]; export const v = list.length[k];',
  'other slot of a literal': 'const box = { g: globalThis, h: other }; export const v = box.h[k];',
  'platform member of the global': 'export const v = globalThis.process[k];',
  'alias written only with other values': 'let g = other; g = { a: 1 }; export const v = g[k];',
  'a local named like the global': 'const globalThis = {}; export const v = globalThis[k];',
  // The idioms that make a flow-insensitive resolver loop: no answer is not a refusal.
  'walk down a path':
    'export function get(root, path) { let cur = root; for (const part of path) cur = cur[part]; return cur; }',
  'walk, with a string accumulator':
    'export function f(o, ks) { let cur = o; for (const k of ks) { cur = cur?.[k]; } return cur; }',
  'two names assigned from each other':
    'export function f(x, y) { let a = x; let b = y; a = b; b = a; return a[k] ?? b[k]; }',
  'a map lookup': 'export const v = lookup[k];',
  'row field': 'export function f(row, name) { return row[name]; }',
};
test('review r4 N1: a computed read through a value the resolver can prove is the global object is refused', () => {
  for (const [label, code] of Object.entries(R4_OBJECTS)) {
    assert.deepEqual(found(code), [BY_NAME], `${label}: ${code}`);
  }
});
test('review r4 N1: …and one it proves is not, or never learns about, is not (no false positives on the idioms)', () => {
  for (const [label, code] of Object.entries(R4_OBJECTS_OTHER)) {
    assert.deepEqual(found(code), [], `${label}: ${code}`);
  }
});

// The named forms follow the same resolver: a controller or a timer reached by member of a value.
const R4_NAMED = {
  'nested global member': ['export const c = new globalThis.global.AbortController();', CONTROLLER],
  'destructured global member': [
    'const { global: g } = globalThis; export const c = new g.AbortController();',
    CONTROLLER,
  ],
  'alias made by assignment': [
    'let g; g = globalThis; export const c = new g.AbortController();',
    CONTROLLER,
  ],
  'alias held in a literal': [
    'const box = { g: globalThis }; export const c = new box.g.AbortController();',
    CONTROLLER,
  ],
  'alias in a conditional': [
    'export const c = new (c ? globalThis : other).AbortController();',
    CONTROLLER,
  ],
  'timer through an assigned alias': [
    'let t; t = globalThis; t.setTimeout(() => c.abort(), 5);',
    TIMER_ABORT,
  ],
  'timer in a chained declaration': [
    'const { setTimeout: later } = g = globalThis; later(() => c.abort(), 5);',
    TIMER_ABORT,
  ],
};
test('review r4 N1: a controller or timer reached by member of a resolved value is the controller or the timer', () => {
  for (const [label, [code, ...ids]] of Object.entries(R4_NAMED)) {
    assert.deepEqual(found(code), ids.sort(), `${label}: ${code}`);
  }
});

// Depth: nothing the resolver cannot finish is a pass.
const nestedLiteral = (depth, leaf) => ({
  pattern: `${'{ a: '.repeat(depth)}${INNER}${' }'.repeat(depth)}`,
  source: `${'{ a: '.repeat(depth)}${leaf}${' }'.repeat(depth)}`,
});
const aliasChain = (length, root) => {
  let code = `const a0 = ${root};`;
  for (let i = 1; i <= length; i++) code += ` const a${i} = a${i - 1};`;
  return `${code} export const v = a${length}[k];`;
};
test('review r4 N1: depth 1..12 resolves exactly — nine levels and more are not a silent pass', () => {
  for (let depth = 1; depth <= 12; depth++) {
    for (const [host, build] of Object.entries(R4_HOSTS)) {
      const global = nestedLiteral(depth, 'globalThis');
      assert.deepEqual(
        found(build(global.pattern, global.source)),
        [BY_NAME],
        `${depth} / ${host}`,
      );
      // …and exactly: a provably different leaf at the same depth is not refused.
      if (host.endsWith('parameter default')) continue;
      const other = nestedLiteral(depth, 'other');
      assert.deepEqual(found(build(other.pattern, other.source)), [], `${depth} / ${host} / other`);
    }
    assert.deepEqual(found(aliasChain(depth, 'globalThis')), [BY_NAME], `alias ${depth}`);
    assert.deepEqual(found(aliasChain(depth, 'other')), [], `alias ${depth} / other`);
  }
  // Every file type, at the depth the review named.
  for (const ext of FILE_TYPES) {
    const { pattern, source } = nestedLiteral(9, 'globalThis');
    assert.deepEqual(
      found(R4_HOSTS.assignment(pattern, source), {
        path: `services/fixture-service/src/probe.${ext}`,
      }),
      [BY_NAME],
      ext,
    );
  }
});
test('review r4 N1: past the resolver’s depth, and past its work budget, it fails closed — whatever the leaf', () => {
  for (const leaf of ['globalThis', 'other']) {
    for (const [host, build] of Object.entries(R4_HOSTS)) {
      const deep = nestedLiteral(70, leaf);
      assert.deepEqual(found(build(deep.pattern, deep.source)), [BY_NAME], `${leaf} / ${host}`);
    }
    assert.deepEqual(found(aliasChain(70, leaf)), [BY_NAME], `alias chain / ${leaf}`);
  }
  const wide = (n) => `[${'other, '.repeat(n)}]`;
  // A timer host the resolver gave up on is a timer host (fail closed there too).
  let timers = 'const a0 = other;';
  for (let i = 1; i <= 70; i++) timers += ` const a${i} = a${i - 1};`;
  assert.deepEqual(found(`${timers} a70.setTimeout(() => c.abort(), 5);`), [TIMER_ABORT]);
  assert.deepEqual(found(`${timers} a3.setTimeout(() => c.abort(), 5);`), []);
  assert.deepEqual(found(`for (const { [k]: C } of ${wide(500)}) use(C);`), []);
  assert.deepEqual(found(`for (const { [k]: C } of ${wide(2500)}) use(C);`), [BY_NAME]);
  assert.deepEqual(
    found(`export const v = ${wide(2500)}[0][k];`),
    [],
    'one element, not the whole array',
  );
  assert.deepEqual(found(`export const v = [...${wide(2500)}, globalThis][3000][k];`), [BY_NAME]);
});

// What the resolver cannot prove is not the global object — for a computed key in a PATTERN,
// that is a refusal. A numeric/symbol key (or naming the global) is how to write the others.
const R4_UNPROVEN = {
  'parameter with no default': 'export function f({ [k]: C }) { return C; }',
  'parameter with a default of another value': 'export function f({ [k]: C } = {}) { return C; }',
  'rest parameter': 'export function f(...[{ [k]: C }]) { return C; }',
  'catch clause': 'try { f(); } catch ({ [k]: C }) { use(C); }',
  'call result': 'const { [k]: C } = getGlobal(); export { C };',
  'new expression': 'const { [k]: C } = new Host(); export { C };',
  await: 'export async function f() { const { [k]: C } = await load(); return C; }',
  this: 'export function f() { const { [k]: C } = this; return C; }',
  'imported value': 'import { host } from "./host"; const { [k]: C } = host; export { C };',
  'default import': 'import host from "./host"; const { [k]: C } = host; export { C };',
  'namespace import': 'import * as host from "./host"; const { [k]: C } = host; export { C };',
  'ambient declaration': 'declare const host: unknown; const { [k]: C } = host; export { C };',
  'for-of over a variable from a call':
    'const list = getHosts(); for (const { [k]: C } of list) use(C);',
  'for-of over a parameter': 'export function f(list) { for (const { [k]: C } of list) use(C); }',
  'iterator of a Set': 'const [{ [k]: C }] = new Set([globalThis]); export { C };',
  'array method': 'const [{ [k]: C }] = [globalThis].map((x) => x); export { C };',
  'Object.assign': 'const { [k]: C } = Object.assign({}, globalThis); export { C };',
  'Reflect.get': 'const { [k]: C } = Reflect.get(globalThis, "global"); export { C };',
  'spread of an unknown':
    'declare const handed: unknown; const { [k]: C } = { ...handed }; export { C };',
  'array spread of an unknown':
    'declare const handed: unknown[]; const [{ [k]: C }] = [...handed]; export { C };',
  'rest over an unknown':
    'declare const handed: unknown[]; const [...[{ [k]: C }]] = handed; export { C };',
  'an object with its own iterator':
    'const [{ [k]: C }] = { *[Symbol.iterator]() { yield globalThis; } }; export { C };',
  'member of a call': 'const { [k]: C } = getBox().host; export { C };',
  'member of a parameter': 'export function f(box) { const { [k]: C } = box.host; return C; }',
  'a variable written from a call':
    'let h = other; h = pick(); const { [k]: C } = h; export { C };',
  'nested in a handed-in pattern': 'export function f({ a: { [k]: C } }) { return C; }',
  'chained to a call': 'let C; ({ [k]: C } = g = getGlobal());',
  'omit idiom':
    'export function without(row, field) { const { [field]: omitted, ...rest } = row; return [omitted, rest]; }',
};
test('review r4 N1: a computed key in a pattern over a source nobody can prove is not the global object is refused', () => {
  for (const [label, code] of Object.entries(R4_UNPROVEN)) {
    assert.deepEqual(found(code), [BY_NAME], `${label}: ${code}`);
  }
  // …unless the key cannot name a global, or the file may hold a controller.
  for (const [label, code] of Object.entries(R4_UNPROVEN)) {
    if (/\[k\]|\[field\]/.test(code)) {
      assert.deepEqual(found(code.replace(/\[(k|field)\]:/, '[1]:')), [], `numeric key / ${label}`);
    }
  }
  allowed(R4_UNPROVEN['call result'], {
    path: 'services/identity-service/src/identity/membership-expiry.scanner.ts',
  });
});

// Each of these is ACCEPTED (PM decision D-095): the rule guards against an accidental
// early-clear deadline, and review catches deliberate obfuscation. They are listed so that the
// documentation (rule header, docs/internal-token-transport-scope.md, PR body) says exactly this
// and no more; a change that closes one must change this table and those texts together.
const ACCEPTED_RESIDUAL = {
  'abort through Reflect.get':
    'const c = handed; setTimeout(() => Reflect.get(c, "abort").call(c), 5);',
  'abort as a constant enum member': 'enum E { A = "abort" } setTimeout(() => c[E.A](), 5);',
  'abort as a constant object member': 'const M = { A: "abort" }; setTimeout(() => c[M.A](), 5);',
  'abort as a constant conditional': 'setTimeout(() => c[true ? "abort" : "x"](), 5);',
  'abort named from data': 'setTimeout(() => c[name](), 5);',
  'Reflect.get of a global timer':
    'const T = Reflect.get(globalThis, "setTimeout"); T(() => c.abort(), 5);',
  'timer host handed in': 'export function f(h, c) { return h.setTimeout(() => c.abort(), 5); }',
  'controller host handed in': 'export function f(h) { return new h.AbortController(); }',
  'qualified type annotation': 'export let c: globalThis.AbortController;',
  'computed name on the timers module':
    'import * as t from "node:timers"; const k = pick(); t[k](() => c.abort(), 5);',
  'timer inside a dynamic-import callback':
    'import("node:timers").then((t) => t.setTimeout(() => c.abort(), 5));',
  'timer host reached through a call': 'getTimers().setTimeout(() => c.abort(), 5);',
  // r4: a computed member read is refused only when its object RESOLVES to the global object
  // (indexing is everywhere: `row[key]`); a value that comes out of a call, a parameter or an
  // import is not followed. (A computed key in a destructuring PATTERN is stricter — see below.)
  'computed read on a call result': 'export const v = getGlobal()[k];',
  'computed read on a call that is handed the global':
    'export const v = Object.assign({}, globalThis)[k];',
  'computed read through Reflect.get of a global member':
    'export const v = Reflect.get(globalThis, "global")[k];',
  'computed read on a handed-in value': 'export function f(h) { return h[k]; }',
  'computed read on an imported value': 'import { host } from "./host"; export const v = host[k];',
  'computed read of an array method result': 'export const v = [globalThis].at(0)[k];',
  // A literal container is read as written; a member added to it afterwards is not followed.
  'member write into a literal object':
    'const box = {}; box.g = globalThis; export const v = box.g[k];',
  'push into a literal array':
    'const list = []; list.push(globalThis); export const v = list[0][k];',
  'Object.assign into a literal':
    'const box = {}; Object.assign(box, { g: globalThis }); export const v = box.g[k];',
  'pattern over a member written afterwards':
    'const box = {}; box.g = globalThis; const { [k]: C } = box.g; export { C };',
  'key built from a numeric that is not provable, on a handed-in host':
    'export function f(h, x) { return h[x - 1]; }',
};
test('accepted residual (D-095): these forms produce no diagnostic, and the docs say so', () => {
  for (const [label, code] of Object.entries(ACCEPTED_RESIDUAL)) {
    assert.deepEqual(found(code), [], label);
  }
});

test('accepted residual: the constant-fold depth is finite, and past it a computed global is refused', () => {
  // A chain longer than the folding depth is not folded…
  let chain = "const k0 = 'abort';";
  for (let i = 1; i <= 12; i++) chain += ` const k${i} = k${i - 1} + '';`;
  allowed(`${chain} setTimeout(() => c[k12](), 5);`);
  // …but for a global it fails closed instead of passing.
  refused(`${chain} export const f = globalThis[k12];`, BY_NAME);
});

test('the decision is on the canonical path: the same files reached through a linked root, and files outside', () => {
  const outside = mkdtempSync(join(tmpdir(), 'exdl-root-'));
  try {
    // The repository reached through a link (a checkout mounted elsewhere, a workspace symlink),
    // linted from there: the linter's own base path is the link, so the rule really runs.
    const linked = join(outside, 'repo');
    symlinkSync(root.replace(/\/$/, ''), linked);
    const using = new Linter({ cwd: linked });
    const via = (code, path) => found(code, { file: join(linked, path), using });
    // Positive control: a file of no list is refused through the link as anywhere.
    assert.deepEqual(via(manualDeadline, 'services/fixture-service/src/probe.ts'), [
      CONTROLLER,
      TIMER_ABORT,
    ]);
    assert.equal(repoPath(join(linked, SHARED_BOUNDARY)), SHARED_BOUNDARY);
    assert.deepEqual(via(manualDeadline, SHARED_BOUNDARY), []);
    // …an allow-list entry is the same file under any name that reaches it…
    const owner = 'services/identity-service/src/identity/membership-expiry.scanner.ts';
    assert.ok(Object.hasOwn(ABORT_OWNERS, owner));
    assert.deepEqual(via('export const c = new AbortController();', owner), []);
    const timerModule = 'scripts/replay-dlq.mjs';
    assert.ok(Object.hasOwn(TIMER_ABORT_MODULES, timerModule));
    assert.deepEqual(via('setTimeout(() => c.abort(), 5);', timerModule), []);
    // …and a real file outside the repository (or reached only by a link out of it) is exempt from nothing.
    const foreign = join(outside, 'exchange-deadline.ts');
    writeFileSync(foreign, 'export {};\n');
    assert.equal(repoPath(foreign), null);
    const linkOut = join(root, 'scripts', `exdl-out-${process.pid}.ts`);
    try {
      symlinkSync(foreign, linkOut);
      assert.equal(repoPath(linkOut), null);
      assert.deepEqual(found(manualDeadline, { file: linkOut }), [CONTROLLER, TIMER_ABORT]);
    } finally {
      rmSync(linkOut, { force: true });
    }
  } finally {
    rmSync(join(outside, 'repo'), { force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------
// FU-001 (review of #536): a logical assignment is worth the right side OR the value its
// target already held, and only the numeric members of `Math` / the well-known symbols are
// proof that a key names no global.
// ---------------------------------------------------------------------------------------
const LOGICAL_OPERATORS = ['||=', '&&=', '??='];
// Each place a value is read; `SRC` is the logical assignment whose LEFT side holds the host.
const FU001_LOGICAL_READS = {
  'member read': ['let g = globalThis; export const v = (g OP other)[k];', [BY_NAME]],
  'member read, chained': [
    'let g = globalThis; let h; export const v = (h = g OP other)[k];',
    [BY_NAME],
  ],
  'alias of the result': [
    'let g = globalThis; const h = (g OP other); export const v = h[k];',
    [BY_NAME],
  ],
  'declaration pattern': [
    'let g = globalThis; const { [k]: C } = (g OP other); export { C };',
    [BY_NAME],
  ],
  'assignment pattern': ['let g = globalThis; let C; ({ [k]: C } = (g OP other));', [BY_NAME]],
  'controller by member': [
    'let g = globalThis; export const c = new (g OP other).AbortController();',
    ['controller'],
  ],
  'timer by member': [
    'let g = globalThis; (g OP other).setTimeout(() => c.abort(), 1);',
    ['timerAbort'],
  ],
  'timer destructured from the result': [
    'let g = globalThis; const { setTimeout: later } = (g OP other); later(() => c.abort(), 1);',
    ['timerAbort'],
  ],
  'timers module kept on the left': [
    "let t = require('node:timers'); (t OP other).setTimeout(() => c.abort(), 1);",
    ['timerAbort'],
  ],
};
test('FU-001: a logical assignment keeps the value its target held — every operator, every read', () => {
  for (const op of LOGICAL_OPERATORS) {
    for (const [label, [template, ids]] of Object.entries(FU001_LOGICAL_READS)) {
      const code = template.replace('OP', op);
      assert.deepEqual(found(code), [...ids].sort(), `${op} / ${label}: ${code}`);
    }
  }
});
test('FU-001: a logical assignment of values that are never the global object is still allowed', () => {
  for (const op of LOGICAL_OPERATORS) {
    for (const code of [
      `let s = 1; export const v = (s ${op} 2)[k];`,
      `let o = { a: 1 }; export const v = (o ${op} other).a;`,
      `let s = "a"; const { [k]: C } = (s ${op} "b"); export { C };`,
    ]) {
      allowed(code);
    }
  }
});

test('FU-001: only the numeric members of Math and the well-known symbols prove a key', () => {
  for (const [position, build] of Object.entries(KEY_POSITIONS)) {
    for (const f of FU001_MATH_FUNCTIONS) {
      allowed(build(`Math.${f}(x)`, ''));
    }
    for (const w of FU001_WELL_KNOWN_SYMBOLS) allowed(build(`Symbol.${w}`, ''));
    for (const [label, key] of Object.entries(FU001_NOT_PROVEN)) {
      assert.ok(
        found(build(key, '')).includes(BY_NAME),
        `${position} / ${label}: ${build(key, '')}`,
      );
    }
  }
});
test('FU-001: the Math list is what the runtime says — each present member returns a number', () => {
  for (const f of FU001_MATH_FUNCTIONS) {
    if (typeof Math[f] !== 'function') continue; // newer than this runtime (f16round, sumPrecise)
    const value = f === 'sumPrecise' ? Math[f]([1, 2]) : Math[f](1, 2);
    assert.equal(typeof value, 'number', `Math.${f}`);
  }
  for (const w of FU001_WELL_KNOWN_SYMBOLS) {
    if (Symbol[w] !== undefined) assert.equal(typeof Symbol[w], 'symbol', `Symbol.${w}`);
  }
  // The proven-not cases really are not numbers / symbols.
  assert.equal(typeof Math.toString(), 'string');
  assert.equal(String(Math.constructor('AbortController')), 'AbortController');
  assert.equal(typeof Symbol.name, 'string');
});
