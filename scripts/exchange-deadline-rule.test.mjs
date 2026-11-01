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
import { join, relative as relativePath, sep } from 'node:path';
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
    // Virtual: nothing at that path.
    assert.deepEqual(both(lintStdin('', path, manualDeadline)), [CONTROLLER, TIMER_ABORT]);
    // On disk: the file really exists at the shadow path (stdin supplies the text, the path decides).
    const first = (() => {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        try {
          statSync(`${root}${parts.slice(0, i).join('/')}`);
        } catch {
          return parts.slice(0, i).join('/');
        }
      }
      return undefined;
    })();
    try {
      mkdirSync(`${root}${path.split('/').slice(0, -1).join('/')}`, { recursive: true });
      writeFileSync(`${root}${path}`, manualDeadline);
      assert.deepEqual(both(lintStdin('', path, manualDeadline)), [CONTROLLER, TIMER_ABORT]);
    } finally {
      if (first) rmSync(`${root}${first}`, { recursive: true, force: true });
      else rmSync(`${root}${path}`, { force: true });
    }
  });
}

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
  'parameter default of another value': 'export function f({ [k]: C } = {}) { return C; }',
  'for-of head over another value': 'for (const { [k]: C } of [other]) use(C);',
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
  'type-wrapped numeric': '(1 + 2) as number',
  'non-null numeric': 'Number(x)!',
  'conditional of numerics': 'c ? 1 : -2',
  symbol: 'Symbol("x")',
  'symbol.for': 'Symbol.for("x")',
  'well-known symbol': 'Symbol.iterator',
  'conditional of symbols': 'c ? Symbol.iterator : Symbol.asyncIterator',
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
  'Number member': 'Number.parseInt(x)',
  'Math call': 'Math.floor(x)',
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
  'nested global member': 'export const c = new globalThis.global.AbortController();',
  'destructured global member':
    'const { global: g } = globalThis; export const c = new g.AbortController();',
  'alias made by assignment': 'let g; g = globalThis; export const c = new g.AbortController();',
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
  // r3: sources of a computed pattern/member that are not the global object by name or direct alias.
  'computed read of a parameter that defaults to the global':
    'export function f(g = globalThis) { return g[k]; }',
  'computed read of a global inside a logical expression':
    'export const v = (globalThis ?? other)[k];',
  'computed read of a global inside a conditional': 'export const v = (c ? globalThis : other)[k];',
  'pattern over a global inside a logical expression':
    'const { [k]: C } = globalThis ?? other; export { C };',
  'pattern over a spread copy of the global': 'const { [k]: C } = { ...globalThis }; export { C };',
  'pattern with a for-of head over a variable iterable':
    'const list = getHosts(); for (const { [k]: C } of list) use(C);',
  'pattern over a member of the global object':
    'const { [k]: C } = globalThis.global; export { C };',
  'pattern in a parameter with no default': 'export function f({ [k]: C }) { return C; }',
  'pattern in a catch clause': 'try { f(); } catch ({ [k]: C }) { use(C); }',
  'pattern over a call': 'const { [k]: C } = getGlobal(); export { C };',
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
