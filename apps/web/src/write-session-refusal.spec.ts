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

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

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

/** Every `'use server'` module under `src/app`, by its path. */
const MODULES = [
  'app/transactions/[id]/actions',
  'app/marketplace/[productId]/place-order-actions',
  'app/orders/[id]/actions',
  'app/assets/actions',
  'app/assets/[id]/actions',
  'app/assets/[id]/document-actions',
  'app/assets/[id]/record-actions',
  'app/assets/[id]/availability-actions',
  'app/assets/[id]/lifecycle-actions',
  'app/usage/actions',
  'app/wallet/actions',
  'app/drivers/actions',
  'app/drivers/[id]/actions',
  'app/maintenance/actions',
  'app/maintenance/[id]/actions',
  'app/maintenance/[id]/repair-actions',
  'app/organizations/actions',
  'app/returns/return-actions',
] as const;

const ACTIONS: Record<string, Record<string, Action>> = Object.fromEntries(
  MODULES.map((path) => [path, require(`./${path}`) as Record<string, Action>]),
);
/* eslint-enable @typescript-eslint/no-require-imports */

const CASES = Object.entries(ACTIONS).flatMap(([route, module]) =>
  Object.entries(module)
    .filter(([name, value]) => name.startsWith('submit') && typeof value === 'function')
    .map(([name, action]) => ({ name: `${route} ${name}`, action })),
);

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

it('covers every server-action module in the portal', () => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name)) {
        if (/^'use server';/.test(readFileSync(full, 'utf8'))) {
          found.push(relative(__dirname, full).replace(/\.ts$/, ''));
        }
      }
    }
  };
  walk(join(__dirname, 'app'));
  expect([...MODULES].sort()).toEqual(found.sort());
});

it('covers every write action in those modules', () => {
  // 33 exported actions today; a new one is added to `ACTIONS` above.
  expect(CASES.length).toBe(35);
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
