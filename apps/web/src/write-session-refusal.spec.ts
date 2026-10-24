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

import { join } from 'node:path';

import { discoverServerActions, scanServerActions } from './test/server-action-discovery';

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
 * `src` of the workspace packages it depends on), found by parsing the sources
 * (`test/server-action-discovery.ts`): a new action module is covered without
 * being listed anywhere, and an inline directive cannot hide from the cases.
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
