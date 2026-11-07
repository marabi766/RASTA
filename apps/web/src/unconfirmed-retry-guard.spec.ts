/**
 * @jest-environment node
 */

/**
 * FU-173: every write action keeps an unresolved send unresolved
 * (`server/unconfirmed-retry.ts`). Found, not listed: every runtime export of
 * every `'use server'` module discovery finds (`test/server-action-discovery.ts`)
 * is called as a retry of an `UNCONFIRMED` send — and of one still `IN_PROGRESS`
 * — with no session, so its first gate refuses and nothing is sent. An action
 * that holds the rule answers `UNCONFIRMED` under the first send's correlation
 * id; one that bypasses it answers its own refusal and fails here.
 *
 * A module that keeps its unresolved sends by a mechanism of its own is listed
 * in `OWN_MECHANISM` with the file that does it; a new module is in neither
 * list and so is held to the shared rule. Store-backed modules account for every
 * static and runtime export by name, including reconciliation exemptions.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  discoverServerActions,
  exportedNames,
  runtimeExports,
} from './test/server-action-discovery';

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
  runtimeExports(module, require(join(REPO_ROOT, module)) as Record<string, unknown>).map(
    ({ exported, label, value }) => ({ module, exported, label, action: value as Action }),
  ),
);
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Modules whose unresolved sends are kept by a mechanism of their own, each with the file that does it. They are not let off the outcome:
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
  'apps/web/src/app/wallet/actions.ts': ['SERVER_STORE', 'server/top-up-request.ts'],
  'apps/web/src/app/suppliers/supplier-actions.ts': [
    'SERVER_STORE',
    'server/supplier-unresolved.ts',
  ],
};

/** Every SERVER_STORE export has a named role; adding or renaming any export fails closed. */
const SERVER_STORE: Readonly<
  Record<
    string,
    { writes: readonly string[]; exemptions: Readonly<Record<string, string>>; tests: string }
  >
> = {
  'apps/web/src/app/projects/actions.ts': {
    writes: ['submitCreateProject'],
    exemptions: {
      releaseUnresolvedCreate: 'Explicit reconciliation; compare-and-delete, no domain write.',
    },
    tests: 'app/projects/actions.spec.ts',
  },
  'apps/web/src/app/procurement/demands/demand-actions.ts': {
    writes: ['submitDemandRequest'],
    exemptions: {
      releaseUnresolvedDemand: 'Explicit reconciliation; compare-and-delete, no domain write.',
    },
    tests: 'app/procurement/demands/demand-actions.spec.ts',
  },
  'apps/web/src/app/suppliers/supplier-actions.ts': {
    writes: [
      'submitRegisterSupplier',
      'submitQualificationRequest',
      'submitApproveQualification',
      'submitRejectQualification',
      'submitSuspendSupplier',
      'submitReinstateSupplier',
    ],
    exemptions: {
      reconcileSupplierWrite: 'Explicit reconciliation; compare-and-delete, no domain write.',
    },
    tests: 'app/suppliers/supplier-actions.spec.ts',
  },
  'apps/web/src/app/wallet/actions.ts': {
    writes: ['submitTopUp'],
    exemptions: {},
    tests: 'app/wallet/actions.spec.ts',
  },
};

function checkStoreExports(module: string, names: readonly string[]): void {
  const entry = SERVER_STORE[module];
  expect(entry).toBeDefined();
  const accounted = [...entry.writes, ...Object.keys(entry.exemptions)];
  expect(new Set(accounted).size).toBe(accounted.length);
  expect([...names].sort()).toEqual([...accounted].sort());
  for (const reason of Object.values(entry.exemptions)) expect(reason.trim()).not.toBe('');
}

it('FU-191: discovers every SERVER_STORE export before classifying its named role', () => {
  for (const [module, [mechanism]] of Object.entries(OWN_MECHANISM)) {
    if (mechanism !== 'SERVER_STORE') continue;
    // Compare labels too: this assertion runs unchanged on #880, whose CASES dropped non-submit exports.
    const expected = runtimeExports(
      module,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(join(REPO_ROOT, module)) as Record<string, unknown>,
    );
    expect(
      CASES.filter((entry) => entry.module === module)
        .map(({ label }) => label)
        .sort(),
    ).toEqual(expected.map(({ label }) => label).sort());
  }
});

it('checks every SERVER_STORE module and every static/runtime export by name', () => {
  const modules = Object.keys(OWN_MECHANISM).filter(
    (module) => OWN_MECHANISM[module][0] === 'SERVER_STORE',
  );
  expect(Object.keys(SERVER_STORE).sort()).toEqual(modules.sort());
  for (const module of modules) {
    checkStoreExports(module, DISCOVERED.exports[module]);
    checkStoreExports(
      module,
      CASES.filter((entry) => entry.module === module).map(({ exported }) => exported),
    );
    for (const entry of CASES.filter((entry) => entry.module === module))
      expect(typeof entry.action).toBe('function');
    // These suites exercise the store-backed dispatch/refusal paths; this guard checks inventory.
    expect(existsSync(join(__dirname, SERVER_STORE[module].tests))).toBe(true);
  }
});

it.each([
  'export async function performWrite() {}',
  'export default async function write() {}',
  'const x = async () => {}; export { x as submitEscape };',
  'const x = async () => {}; export { x as performWrite };',
  'export * from "./other";',
])('refuses an unaccounted SERVER_STORE export: %s', (addition) => {
  const module = 'apps/web/src/app/wallet/actions.ts';
  const names = exportedNames(
    `'use server'; export async function submitTopUp() {} ${addition}`,
    'actions.ts',
  );
  expect(() => checkStoreExports(module, names)).toThrow();
});

/**
 * The action's own leading arguments (ids), then the previous state, then the form —
 * posting the held request's key, so the attempt runs (PR-880 r1 F1: another key
 * sends nothing).
 */
function retry(action: Action, previous: { submissionId?: string }): Promise<unknown> {
  const ids = Array.from({ length: Math.max(0, action.length - 2) }, (_, i) => `ID_${i + 1}`);
  const form = new FormData();
  if (previous.submissionId) form.set('submission', previous.submissionId);
  return action(...ids, previous, form);
}

const UNCONFIRMED = {
  kind: 'UNCONFIRMED',
  correlationId: 'COR-FIRST',
  submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
};
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
