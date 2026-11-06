/**
 * @jest-environment node
 */

/**
 * FU-173: every write action keeps an unresolved send unresolved
 * (`server/unconfirmed-retry.ts`). Found, not listed: every `submit*` export of
 * every `'use server'` module discovery finds (`test/server-action-discovery.ts`)
 * is called as a retry of an `UNCONFIRMED` send — and of one still `IN_PROGRESS`
 * — with no session, so its first gate refuses and nothing is sent. An action
 * that holds the rule answers `UNCONFIRMED` under the first send's correlation
 * id; one that bypasses it answers its own refusal and fails here.
 *
 * A module that keeps its unresolved sends by a mechanism of its own is listed
 * in `OWN_MECHANISM` with the file that does it; a new module is in neither
 * list and so is held to the shared rule.
 */

import { join } from 'node:path';

import { discoverServerActions, runtimeExports } from './test/server-action-discovery';

jest.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

type Action = (...args: unknown[]) => Promise<unknown>;

const REPO_ROOT = join(__dirname, '../../..');
const DISCOVERED = discoverServerActions(REPO_ROOT, join(__dirname, '..'));

/* eslint-disable @typescript-eslint/no-require-imports */
const CASES = DISCOVERED.modules.flatMap((module) =>
  runtimeExports(module, require(join(REPO_ROOT, module)) as Record<string, unknown>)
    .filter(({ exported, value }) => exported.startsWith('submit') && typeof value === 'function')
    .map(({ label, value }) => ({ module, label, action: value as Action })),
);
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Modules whose unresolved sends are kept by a mechanism of their own (before
 * FU-173), each with the file that does it. They are not let off the outcome:
 *
 *   - `PREVIOUS_STATE`: the form's previous state, like the shared rule. Their
 *     states have no `IN_PROGRESS` (the writer's is answered as `UNCONFIRMED`),
 *     so only the `UNCONFIRMED` retry is checked — and it must stay `UNCONFIRMED`.
 *   - `SERVER_STORE`: a record in `server/unresolved-request.ts`, reserved before
 *     the dispatch and kept by every refusal of a retry; the page draws the held
 *     request from it, so the previous state carries nothing (PR-830 r2: verified).
 */
const OWN_MECHANISM: Readonly<
  Record<string, readonly ['PREVIOUS_STATE' | 'SERVER_STORE', string]>
> = {
  'apps/web/src/app/contracts/[id]/contract-actions.ts': [
    'PREVIOUS_STATE',
    'lib/unresolved-contract-command.ts',
  ],
  'apps/web/src/app/contracts/[id]/statement-actions.ts': [
    'PREVIOUS_STATE',
    'lib/unresolved-statement.ts',
  ],
  'apps/web/src/app/inventory/inventory-actions.ts': [
    'PREVIOUS_STATE',
    'lib/unresolved-inventory.ts',
  ],
  'apps/web/src/app/marketplace/[productId]/place-order-actions.ts': [
    'PREVIOUS_STATE',
    'place-order-form-state.ts (withRetryNote)',
  ],
  'apps/web/src/app/returns/return-actions.ts': ['PREVIOUS_STATE', 'lib/unresolved-return.ts'],
  'apps/web/src/app/tenders/[id]/bid-actions.ts': ['PREVIOUS_STATE', 'lib/unresolved-bid.ts'],
  'apps/web/src/app/tenders/[id]/owner-actions.ts': [
    'PREVIOUS_STATE',
    'lib/unresolved-tender-command.ts',
  ],
  'apps/web/src/app/transactions/[id]/actions.ts': ['PREVIOUS_STATE', 'lib/unresolved-dispute.ts'],
  'apps/web/src/app/procurement/demands/demand-actions.ts': [
    'SERVER_STORE',
    'server/unresolved-request.ts',
  ],
  'apps/web/src/app/projects/actions.ts': ['SERVER_STORE', 'server/unresolved-request.ts'],
  'apps/web/src/app/suppliers/supplier-actions.ts': [
    'SERVER_STORE',
    'server/supplier-unresolved.ts',
  ],
};

/** The action's own leading arguments (ids), then the previous state, then the form. */
function retry(action: Action, previous: unknown): Promise<unknown> {
  const ids = Array.from({ length: Math.max(0, action.length - 2) }, (_, i) => `ID_${i + 1}`);
  return action(...ids, previous, new FormData());
}

const UNCONFIRMED = { kind: 'UNCONFIRMED', correlationId: 'COR-FIRST' };
const IN_PROGRESS = {
  kind: 'IN_PROGRESS',
  submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
  values: {},
  retryAfterSeconds: 1,
  correlationId: 'COR-WAIT',
};

const SHARED = CASES.filter(({ module }) => OWN_MECHANISM[module] === undefined);
const OWN_PREVIOUS = CASES.filter(({ module }) => OWN_MECHANISM[module]?.[0] === 'PREVIOUS_STATE');

it('finds the write actions, and holds every one outside OWN_MECHANISM to the shared rule', () => {
  expect(CASES.length).toBeGreaterThan(30);
  // The 7 project commands and the 14 modules of PR-830 r2's follow-up table, at least.
  expect(SHARED.length).toBeGreaterThanOrEqual(37);
});

it('names only modules that exist in OWN_MECHANISM', () => {
  for (const module of Object.keys(OWN_MECHANISM)) expect(DISCOVERED.modules).toContain(module);
});

describe.each(SHARED)('$label (the shared rule)', ({ action }) => {
  it('a retry of an UNCONFIRMED send stays UNCONFIRMED, under the first correlation id', async () => {
    expect(await retry(action, UNCONFIRMED)).toEqual(
      expect.objectContaining({ kind: 'UNCONFIRMED', correlationId: 'COR-FIRST' }),
    );
  });
  it('a retry of a send still IN_PROGRESS is UNCONFIRMED', async () => {
    expect(await retry(action, IN_PROGRESS)).toEqual(
      expect.objectContaining({ kind: 'UNCONFIRMED', correlationId: 'COR-WAIT' }),
    );
  });
});

describe.each(OWN_PREVIOUS)('$label (its own previous-state rule)', ({ action }) => {
  it('a retry of an UNCONFIRMED send stays UNCONFIRMED', async () => {
    expect(await retry(action, UNCONFIRMED)).toEqual(
      expect.objectContaining({ kind: 'UNCONFIRMED' }),
    );
  });
});
