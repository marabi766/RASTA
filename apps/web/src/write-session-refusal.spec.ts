/**
 * @jest-environment node
 */

/**
 * Every write action in the portal tells an ended session from one that is only
 * unavailable for now, with the real `currentSession` and `missingSessionReason`
 * reading what middleware forwarded (`server/session-state.ts`): only a request
 * middleware marked "refresh unavailable" is `SESSION_UNAVAILABLE`; every other
 * request with no usable session is `NO_SESSION`. Before, all of them said
 * "your session has ended" — a login that may come back, told to sign in again.
 *
 * Each action is called with its own arguments padded by placeholders: the
 * session is the first gate, so nothing after it runs either way.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  actionKey,
  actionLabel,
  assertPlainModulePath,
  coveredActions,
  discoverServerActions,
  exportedNames,
  runtimeExports,
  scanServerActions,
} from './test/server-action-discovery';

let forwarded = new Headers();

jest.mock('next/headers', () => ({
  headers: async () => forwarded,
  cookies: async () => ({ get: () => undefined }),
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { REFRESH_UNAVAILABLE, SESSION_STATE_HEADER } =
  require('@/server/session-state') as typeof import('@/server/session-state');

type Action = (...args: never[]) => Promise<unknown>;

/**
 * Every `'use server'` module Next can compile for the web app (all of `apps/web` and the
 * workspace packages it depends on), found by parsing the sources
 * (`test/server-action-discovery.ts`): a new action module is covered without
 * being listed anywhere, and an inline directive cannot hide from the cases.
 *
 * This discovery is the fast local early warning. The authority is the compiler's
 * manifest; holding it to these cases (by the same `actionKey` identity) follows in a
 * separate, stacked change.
 */
const REPO_ROOT = join(__dirname, '../../..');
const DISCOVERED = discoverServerActions(REPO_ROOT, join(__dirname, '..'));
const MODULES = DISCOVERED.modules;

// Keyed and loaded by the exact file name, extension included: `actions.ts` and
// `actions.tsx` are two modules here as they are to Next (which prefers `.tsx`).
const ACTIONS: Record<string, Record<string, unknown>> = Object.fromEntries(
  MODULES.map((path) => [path, require(join(REPO_ROOT, path)) as Record<string, unknown>]),
);
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Every runtime export of every discovered module, identified by `actionKey` (the JSON of
 * `[module, export]`); a name that is not a plain identifier or `default` throws here, so
 * this spec fails to load. The `label` is for titles only and is never compared.
 */
const EXPORTS = Object.entries(ACTIONS).flatMap(([route, module]) => runtimeExports(route, module));

/** One case per exported action; nothing here is listed by hand. */
const CASES = EXPORTS.filter(
  ({ exported, value }) => exported.startsWith('submit') && typeof value === 'function',
).map(({ key, label, value }) => ({ key, label, action: value as Action }));

/**
 * An exported action that is not a `submit*` form-state action has no `REFUSED` result to
 * return; it must be listed here (by `actionKey`) with where it sends a request that has no
 * session. A new non-`submit*` export that is not listed fails the coverage case below.
 */
const NO_SESSION_REDIRECTS = new Map<string, string>([
  [
    actionKey('apps/web/src/app/projects/actions.ts', 'releaseUnresolvedCreate'),
    '/login?returnTo=/projects',
  ],
]);

const REDIRECT_CASES = EXPORTS.filter(
  ({ exported, value }) => !exported.startsWith('submit') && typeof value === 'function',
).map(({ key, label, value }) => ({ key, label, action: value as Action }));

/** The action's own leading arguments (ids), then the previous state, then the form. */
function call(action: Action): Promise<unknown> {
  const ids = Array.from({ length: Math.max(0, action.length - 2) }, (_, i) => `ID_${i + 1}`);
  return (action as (...args: unknown[]) => Promise<unknown>)(
    ...ids,
    { kind: 'IDLE' },
    new FormData(),
  );
}

beforeEach(() => {
  forwarded = new Headers();
});

it('finds the server-action modules', () => {
  expect(MODULES.length).toBeGreaterThan(0);
});

it('has no server action in a test file: a production import could still reach it', () => {
  expect(
    DISCOVERED.inTestFiles.map((at) => `${at}: server actions are not allowed in test files`),
  ).toEqual([]);
});

it('has no basename with several compilable extensions in one directory', () => {
  // Jest and Next resolve `./actions` differently when both `actions.ts` and `actions.tsx` exist.
  expect(
    DISCOVERED.ambiguous.map((files) => `${files}: same basename, ambiguous resolution`),
  ).toEqual([]);
});

it('has no inline server action: a function-scoped directive is outside the cases', () => {
  // Message: move it to a 'use server' module.
  expect(DISCOVERED.inline).toEqual([]);
});

it('has a refusal case for exactly the (module, export) pairs discovery finds', () => {
  // Both sides are `actionKey` identities (tuples), never display text.
  expect([...coveredActions(DISCOVERED)].sort()).toEqual(
    [...CASES, ...REDIRECT_CASES].map(({ key }) => key).sort(),
  );
});

it('reads the same export names from syntax as the module has at runtime', () => {
  for (const module of MODULES) {
    expect([module, DISCOVERED.exports[module]]).toEqual([
      module,
      Object.keys(ACTIONS[module]).sort(),
    ]);
  }
});

describe('export names (negative control)', () => {
  it('reads functions, consts, lists, defaults and re-exports, not types', () => {
    const source = [
      "'use server';",
      'export async function submitA() {}',
      'export const submitB = async () => {}, submitC = 1;',
      'const d = 1; const e = 2;',
      'export { d, e as submitE };',
      'export default async function () {}',
      'export type T = string; export interface I {}',
      "export type { U } from './u';",
      "export { f } from './f';",
      "export * as ns from './g';",
    ].join('\n');
    expect(exportedNames(source, 'x.ts')).toEqual(
      ['d', 'default', 'f', 'ns', 'submitA', 'submitB', 'submitC', 'submitE'].sort(),
    );
  });
  it('flags a star re-export, which no case can name', () => {
    expect(exportedNames("'use server';\nexport * from './g';\n", 'x.ts')).toEqual(['*']);
  });
});

describe('action identity (r5 F1)', () => {
  // The reviewer's collision: with a space-delimited key these two pairs were the same string.
  const COVERED = [
    'packages/contracts/src/collision.js',
    'submitX/build/probe.ts submitY',
  ] as const;
  const UNGATED = [
    'packages/contracts/src/collision.js submitX/build/probe.ts',
    'submitY',
  ] as const;

  it('gives two different pairs two different keys, whatever the characters', () => {
    expect(actionKey(...COVERED)).not.toBe(actionKey(...UNGATED));
    expect(actionKey('a/b.ts', 'submitX')).toBe('["a/b.ts","submitX"]');
    const pairs: Array<[string, string]> = [
      ['a b', 'c'],
      ['a', 'b c'],
      ['a"', ',"b'],
      ['a",', '"b'],
      ['a\\', 'b'],
      ['a', '\\b'],
    ];
    expect(new Set(pairs.map(([m, e]) => actionKey(m, e))).size).toBe(pairs.length);
  });

  it('does not let a covered alias vouch for another module’s ungated action', () => {
    const covered = new Set([actionKey(...COVERED)]);
    expect(covered.has(actionKey(...UNGATED))).toBe(false);
  });

  it('refuses the alias export name in discovery (static)', () => {
    const source =
      "'use server';\nconst gated = async () => {};\nexport { gated as 'submitX/build/probe.ts submitY' };\n";
    expect(() => exportedNames(source, 'collision.js')).toThrow(
      /not a plain identifier or default/,
    );
  });

  it('refuses the alias export name in the loaded module (runtime, the spec)', () => {
    expect(() => runtimeExports(COVERED[0], { [COVERED[1]]: () => undefined })).toThrow(
      /not a plain identifier or default/,
    );
  });

  it.each([
    ['a space', 'a b'],
    ['a slash', 'a/b'],
    ['a dot', 'a.b'],
    ['a hyphen', 'a-b'],
    ['a newline', 'a\nb'],
    ['a NUL', 'a\u0000b'],
    ['U+2028', 'a\u2028b'],
    ['an empty name', ''],
    ['a digit first', '1a'],
    ['a non-ASCII letter', 'caf\u00e9'],
    ['star', '*'],
  ])('refuses an export name with %s, statically and at runtime', (_name, name) => {
    expect(() => runtimeExports('a.ts', { [name]: 1 })).toThrow(/not a plain identifier/);
    expect(() =>
      exportedNames(`'use server';\nexport { x as ${JSON.stringify(name)} };`, 'a.ts'),
    ).toThrow(/not a plain identifier/);
  });

  it('accepts identifiers, $ and _, and default', () => {
    expect(
      runtimeExports('a.ts', { submitX: 1, _a$1: 2, default: 3 }).map((e) => e.exported),
    ).toEqual(['submitX', '_a$1', 'default']);
  });

  it('keeps ordinary module paths (separators, extensions, spaces) and refuses control characters', () => {
    expect(() => assertPlainModulePath('apps/web/src/a b/actions.ts')).not.toThrow();
    for (const bad of ['a\nb.ts', 'a\u0000b.ts', 'a\u2028b.ts', 'a\u007fb.ts', '']) {
      expect(() => assertPlainModulePath(bad)).toThrow(/control character/);
    }
  });

  it('shows a label with escapes, never raw control characters', () => {
    expect(actionLabel('a\nb', 'c')).toBe('"a\\nb" "c"');
    const raw = [...actionLabel('a\u2028b\u0085\u0000', 'c')].filter((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    });
    expect(raw).toEqual([]);
  });
});

describe('discovery (negative control)', () => {
  const body = 'export async function submitDummy() { return { kind: "OK" }; }\n';
  it.each([
    ['a leading comment', `// wallet actions\n'use server';\n${body}`],
    ['a blank line first', `\n\n'use server';\n${body}`],
    ['double quotes', `"use server";\n${body}`],
    ['no semicolon', `'use server'\n${body}`],
    ['a block comment and tsx', `/* x */\n"use server"\n${body}`],
  ])('finds a module with %s', (_, source) => {
    expect(scanServerActions(source, 'x.tsx')).toEqual({
      fileLevel: expect.any(Number),
      inline: [],
    });
  });
  // r4 F1: the cooked value is `use server`; Next registers every spelling. One parser decodes them.
  const SPELLINGS: Array<[string, string]> = [
    ['an LF continuation', "'use ser\\\nver'"],
    ['a CR continuation', "'use ser\\\rver'"],
    ['a CRLF continuation', "'use ser\\\r\nver'"],
    ['a U+2028 continuation', "'use ser\\\u2028ver'"],
    ['a U+2029 continuation', "'use ser\\\u2029ver'"],
    ['an identity escape in server', "'use s\\erver'"],
    ['an identity escape in serve', "'use serv\\er'"],
    ['a hex escape', "'use s\\x65rver'"],
    ['a unicode escape', "'use \\u0073erver'"],
    ['a code point escape', "'use \\u{73}erver'"],
  ];
  it.each(SPELLINGS)('finds a file-level directive spelled with %s', (_, literal) => {
    expect(scanServerActions(`${literal};\n${body}`, 'x.ts').fileLevel).toBe(1);
  });
  it.each(SPELLINGS)('finds an inline directive spelled with %s', (_, literal) => {
    expect(
      scanServerActions(`export async function a() {\n${literal};\n}\n`, 'x.ts').inline,
    ).toEqual([2]);
  });
  it.each(SPELLINGS)(
    'reports a file spelled with %s: module, inline and test file',
    (_, literal) => {
      const repo = mkdtempSync(join(tmpdir(), 'discovery-'));
      try {
        const app = join(repo, 'apps/web');
        mkdirSync(join(repo, 'packages'), { recursive: true });
        mkdirSync(join(app, 'src/lib'), { recursive: true });
        writeFileSync(join(app, 'package.json'), '{"name":"w"}');
        writeFileSync(join(app, 'src/lib/mod.ts'), `${literal};\n${body}`);
        writeFileSync(
          join(app, 'src/lib/inline.ts'),
          `export async function a() {\n${literal};\n}\n`,
        );
        writeFileSync(join(app, 'src/lib/probe.test.ts'), `${literal};\n${body}`);
        const found = discoverServerActions(repo, app);
        expect(found.modules).toEqual(['apps/web/src/lib/mod.ts']);
        expect(found.exports['apps/web/src/lib/mod.ts']).toEqual(['submitDummy']);
        expect(found.inline).toEqual(['apps/web/src/lib/inline.ts:2']);
        expect(found.inTestFiles).toEqual(['apps/web/src/lib/probe.test.ts:1']);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );
  it('does not take a template literal or a parenthesised string for a directive', () => {
    expect(scanServerActions('`use server`;\n', 'x.ts').fileLevel).toBeNull();
    expect(scanServerActions("('use server');\n", 'x.ts').fileLevel).toBeNull();
  });
  it('finds an inline directive, with its line', () => {
    const source = `export async function a() {\n  "use server";\n  return 1;\n}\n`;
    expect(scanServerActions(source, 'x.ts')).toEqual({ fileLevel: null, inline: [2] });
  });
  it('does not take a string in the middle of a file for a directive', () => {
    expect(scanServerActions(`const a = 1;\n'use server';\n`, 'x.ts').fileLevel).toBeNull();
  });
});

it('covers every exported action of every module: a `submit*` function or a listed redirect', () => {
  // A `'use server'` export that is not exercised below would be an
  // unguarded write, so the exports and the cases must be the same set.
  const covered = new Set([...CASES, ...REDIRECT_CASES].map(({ key }) => key));
  const uncovered = EXPORTS.filter(({ key }) => !covered.has(key)).map(({ label }) => label);
  expect(uncovered).toEqual([]);
  // A listed redirect that no longer exists is a stale entry, not a silent pass.
  expect(REDIRECT_CASES.map(({ key }) => key).sort()).toEqual(
    [...NO_SESSION_REDIRECTS.keys()].sort(),
  );
});

describe.each(REDIRECT_CASES)('$label', ({ key, action }) => {
  it('a request with no session is sent to sign in', async () => {
    const thrown = await (action as (...args: unknown[]) => Promise<unknown>)(new FormData()).then(
      () => undefined,
      (error: unknown) => error,
    );
    // Exact message: `toThrow(string)` would also accept a longer URL.
    expect((thrown as Error | undefined)?.message).toBe(
      `NEXT_REDIRECT:${NO_SESSION_REDIRECTS.get(key)}`,
    );
  });
});

describe.each(CASES)('$label', ({ action }) => {
  it('a request middleware marked "refresh unavailable": SESSION_UNAVAILABLE, not ended', async () => {
    forwarded.set(SESSION_STATE_HEADER, REFRESH_UNAVAILABLE);
    expect(await call(action)).toEqual({ kind: 'REFUSED', reason: 'SESSION_UNAVAILABLE' });
  });

  it('any other request with no session: NO_SESSION', async () => {
    expect(await call(action)).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
  });
});
