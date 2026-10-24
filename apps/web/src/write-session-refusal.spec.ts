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
  coveredActions,
  discoverServerActions,
  exportedNames,
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
 * The AUTHORITY on which modules define server actions is the compiler's manifest:
 * `scripts/check-server-action-coverage.mjs` (CI, after the web build) fails when the
 * build compiled an action whose (module, export) is not in this spec's cases. This
 * discovery is the fast local early warning, and it is the set the script compares with.
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

/** Every runtime export of every discovered module, as `<module> <export>`. */
const EXPORTS = Object.entries(ACTIONS).flatMap(([route, module]) =>
  Object.entries(module).map(([name, value]) => ({
    name: `${route} ${name}`,
    exported: name,
    value,
  })),
);

/** One case per exported action; nothing here is listed by hand. */
const CASES = EXPORTS.filter(
  ({ exported, value }) => exported.startsWith('submit') && typeof value === 'function',
).map(({ name, value }) => ({ name, action: value as Action }));

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

it('has a refusal case for exactly the (module, export) pairs the compiler manifest is held to', () => {
  // `coveredActions` is what scripts/check-server-action-coverage.mjs compares the manifest with.
  expect([...coveredActions(DISCOVERED)].sort()).toEqual(CASES.map(({ name }) => name).sort());
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
  it('builds one key per pair', () => {
    expect(actionKey('a/b.ts', 'submitX')).toBe('a/b.ts submitX');
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

it('covers every exported action of every module: each is a `submit*` function', () => {
  // A `'use server'` export that is not exercised below would be an
  // unguarded write, so the exports and the cases must be the same set.
  const covered = new Set(CASES.map(({ name }) => name));
  const uncovered = EXPORTS.map(({ name }) => name).filter((name) => !covered.has(name));
  expect(uncovered).toEqual([]);
});

describe.each(CASES)('$name', ({ action }) => {
  it('a request middleware marked "refresh unavailable": SESSION_UNAVAILABLE, not ended', async () => {
    forwarded.set(SESSION_STATE_HEADER, REFRESH_UNAVAILABLE);
    expect(await call(action)).toEqual({ kind: 'REFUSED', reason: 'SESSION_UNAVAILABLE' });
  });

  it('any other request with no session: NO_SESSION', async () => {
    expect(await call(action)).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
  });
});
