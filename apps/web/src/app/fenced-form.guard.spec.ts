import { join } from 'node:path';

import {
  fencedFormViolations,
  fencedForms,
  fencedModules,
  readSources,
} from '@/test/fenced-form-guard';

/**
 * PR 405 review 4, R5: no fenced form may complete a submission — returned or
 * thrown, a first send or a re-send — outside the one boundary, nor be drawn
 * without the one restore path (R4). Structural: the forms are found by what
 * they import and call, so a future form built on a `fencedSlot` store is held
 * to the same rules (`src/test/fenced-form-guard.ts`).
 */

const SRC = join(__dirname, '..');

describe('the tree', () => {
  const sources = readSources(SRC);

  it('finds the seven stores built on fencedSlot, and their seven forms', () => {
    expect([...fencedModules(sources)].sort()).toEqual([
      'lib/unresolved-bid.ts',
      'lib/unresolved-contract-command.ts',
      'lib/unresolved-dispute.ts',
      'lib/unresolved-marker.ts',
      'lib/unresolved-order.ts',
      'lib/unresolved-return.ts',
      'lib/unresolved-statement.ts',
      'lib/unresolved-tender-command.ts',
    ]);
    expect(fencedForms(sources)).toEqual([
      'app/contracts/[id]/ContractCommandForm.tsx',
      'app/contracts/[id]/StatementCommandForm.tsx',
      'app/marketplace/[productId]/PlaceOrderForm.tsx',
      'app/returns/ReturnCommandForm.tsx',
      'app/tenders/[id]/BidCommandForm.tsx',
      'app/tenders/[id]/OwnerCommandForm.tsx',
      'app/transactions/[id]/DisputeCommandForm.tsx',
    ]);
  });

  it('every fenced form submits only through submitThroughSlot and is drawn only by UnresolvedForm', () => {
    expect(fencedFormViolations(sources)).toEqual([]);
  });
});

describe('the guard fails where it must', () => {
  const STORE = `
    import { fencedSlot } from './unresolved-tenancy';
    const slot = fencedSlot('p.', parse, { closing: () => false });
    export const saveThing = () => slot.start();
    export const answerThing = () => slot.answer();
    export const settleThing = () => slot.settle();
    export const clearThing = () => slot.release();
    export const restoreThing = () => null;
  `;
  const COMPLIANT = `
    import { useActionState, useCallback } from 'react';
    import { submitThroughSlot } from '@/lib/fenced-submission';
    import { UnresolvedForm } from '@/app/UnresolvedQuarantine';
    import { answerThing, clearThing, restoreThing, saveThing, settleThing } from '@/lib/thing-store';
    import { submitThing } from './thing-actions';
    export function ThingForm() {
      return <UnresolvedForm restore={() => restoreThing()}>{() => <Body />}</UnresolvedForm>;
    }
    function Body() {
      const send = useCallback(
        (previous, form) => {
          const retrying = previous.kind === 'UNCONFIRMED' ? previous : null;
          return submitThroughSlot({
            remember: () => saveThing(),
            send: () => submitThing(previous, form),
            answer: (state) => answerThing(state),
            settle: () => settleThing(),
            failed: () => null,
          });
        },
        [],
      );
      const [state, action] = useActionState(send, null);
      return <button onClick={() => clearThing()} />;
    }
  `;
  const tree = (form: string, extra: Record<string, string> = {}) =>
    new Map<string, string>([
      ['lib/thing-store.ts', STORE],
      ['lib/fenced-submission.ts', 'export function submitThroughSlot() {}'],
      ['app/UnresolvedQuarantine.tsx', 'export function UnresolvedForm() {}'],
      ['app/thing/thing-actions.ts', 'export async function submitThing() {}'],
      ['app/thing/ThingForm.tsx', form],
      ...Object.entries(extra),
    ]);
  const rules = (form: string, extra?: Record<string, string>) =>
    fencedFormViolations(tree(form, extra)).map((violation) => violation.rule);

  it('a compliant form passes, and is found though no list names it', () => {
    expect(fencedForms(tree(COMPLIANT))).toEqual(['app/thing/ThingForm.tsx']);
    expect(rules(COMPLIANT)).toEqual([]);
  });

  it('a form built on a marker store (a store built on a fencedSlot store) is found too', () => {
    const marker = {
      'lib/thing-marker.ts':
        "import { saveThing } from './thing-store';\nexport const x = saveThing;",
    };
    const form = COMPLIANT.replace("from '@/lib/thing-store'", "from '@/lib/thing-marker'");
    expect(fencedForms(tree(form, marker))).toEqual(['app/thing/ThingForm.tsx']);
  });

  it.each([
    [
      'its own thrown handler returning UNCONFIRMED (the r4 bypass)',
      COMPLIANT.replace(
        'return submitThroughSlot({',
        "try { await submitThing(previous, form); } catch (error) { return { kind: 'UNCONFIRMED' }; }\n          return submitThroughSlot({",
      ),
      ['callback', 'completion', 'transport'],
    ],
    [
      'an early HELD returned before the boundary',
      COMPLIANT.replace(
        'return submitThroughSlot({',
        "if (retrying) return { kind: 'HELD' };\n          return submitThroughSlot({",
      ),
      ['callback'],
    ],
    [
      'a .catch on the transport inside send',
      COMPLIANT.replace(
        'send: () => submitThing(previous, form),',
        "send: () => submitThing(previous, form).catch(() => ({ kind: 'UNCONFIRMED' })),",
      ),
      ['completion'],
    ],
    [
      'the session probe or redirect test of its own',
      COMPLIANT.replace(
        "import { submitThroughSlot } from '@/lib/fenced-submission';",
        "import { submitThroughSlot } from '@/lib/fenced-submission';\n    import { isRedirect } from '@/lib/session-refusal';",
      ),
      ['completion'],
    ],
    [
      'an answer made outside the boundary',
      COMPLIANT.replace(
        'return <button onClick={() => clearThing()} />;',
        'answerThing(state);\n      return <button />;',
      ),
      ['store'],
    ],
    [
      'the transport called outside send',
      COMPLIANT.replace(
        'remember: () => saveThing(),',
        'remember: () => (submitThing(previous, form), saveThing()),',
      ),
      ['transport'],
    ],
    [
      'a callback that is not the boundary at all',
      COMPLIANT.replace(
        'const [state, action] = useActionState(send, null);',
        'const [state, action] = useActionState(async () => null, null);',
      ),
      ['callback'],
    ],
    [
      'the gate drawn directly, without the restore path',
      COMPLIANT.replace(
        'return <UnresolvedForm restore={() => restoreThing()}>{() => <Body />}</UnresolvedForm>;',
        'return <QuarantineGate><Body /></QuarantineGate>;',
      ),
      ['drawn', 'drawn', 'drawn'],
    ],
    [
      'no boundary imported',
      COMPLIANT.replace("import { submitThroughSlot } from '@/lib/fenced-submission';", ''),
      ['boundary'],
    ],
  ] as const)('%s', (_label, form, expected) => {
    expect(form).not.toBe(COMPLIANT);
    expect([...new Set(rules(form))].sort()).toEqual([...new Set(expected)].sort());
  });

  it('QuarantineGate drawn by any other file is refused', () => {
    expect(
      rules(COMPLIANT, { 'app/other/Other.tsx': 'export const X = () => <QuarantineGate />;' }),
    ).toEqual(['drawn']);
  });
});
