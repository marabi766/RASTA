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
 *
 * Review 5, R7: names are resolved, not spelled — an aliased, namespace or
 * barrel spelling of a bypass is refused, and the same spelling of a valid
 * form passes (PM addendum G).
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

  it('every fenced form submits only through submitThroughSlot, holds its state through useSlotActionState and is drawn only by UnresolvedForm', () => {
    expect(fencedFormViolations(sources)).toEqual([]);
  });
});

describe('the guard fails where it must', () => {
  const TENANCY = 'export function fencedSlot() {}';
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
    import { useCallback } from 'react';
    import { submitThroughSlot, useSlotActionState } from '@/lib/fenced-submission';
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
      const [state, action] = useSlotActionState(send, null);
      return <button onClick={() => clearThing()} />;
    }
  `;
  const tree = (form: string, extra: Record<string, string> = {}) =>
    new Map<string, string>([
      ['lib/unresolved-tenancy.ts', TENANCY],
      ['lib/thing-store.ts', STORE],
      [
        'lib/fenced-submission.ts',
        "import { useActionState } from 'react';\nexport function submitThroughSlot() {}\nexport function useSlotActionState(s, i) { return useActionState(s, i); }",
      ],
      [
        'lib/session-refusal.ts',
        'export function isRedirect() {}\nexport function sessionHasEnded() {}\nexport const SESSION_REFUSAL_MESSAGES = {};',
      ],
      [
        'app/UnresolvedQuarantine.tsx',
        'export function UnresolvedForm() {}\nexport function QuarantineGate() {}',
      ],
      ['app/thing/thing-actions.ts', "'use server';\nexport async function submitThing() {}"],
      ['app/thing/ThingForm.tsx', form],
      ...Object.entries(extra),
    ]);
  const rules = (form: string, extra?: Record<string, string>) =>
    fencedFormViolations(tree(form, extra)).map((violation) => violation.rule);
  const edit = (...pairs: [string, string][]) =>
    pairs.reduce((form, [from, to]) => {
      expect(form).toContain(from);
      return form.split(from).join(to);
    }, COMPLIANT);

  it('a compliant form passes, and is found though no list names it', () => {
    expect(fencedForms(tree(COMPLIANT))).toEqual(['app/thing/ThingForm.tsx']);
    expect(rules(COMPLIANT)).toEqual([]);
  });

  it('a form built on a marker store (a store built on a fencedSlot store) is found too', () => {
    const marker = {
      'lib/thing-marker.ts': `
        import { fencedSlot } from './unresolved-tenancy';
        export function markerOf(prefix) { return fencedSlot(prefix); }
      `,
      'lib/thing-built.ts': `
        import { markerOf } from './thing-marker';
        const store = markerOf('p.');
        export const saveThing = () => store.save();
        export const answerThing = () => store.answer();
        export const settleThing = () => store.settle();
        export const clearThing = () => null;
        export const restoreThing = () => null;
      `,
    };
    const form = COMPLIANT.replace("from '@/lib/thing-store'", "from '@/lib/thing-built'");
    expect([...fencedModules(tree(form, marker))].sort()).toEqual([
      'lib/thing-built.ts',
      'lib/thing-marker.ts',
      'lib/thing-store.ts',
    ]);
    expect(fencedForms(tree(form, marker))).toEqual(['app/thing/ThingForm.tsx']);
    expect(rules(form, marker)).toEqual([]);
  });

  describe('valid spellings that use the boundary pass (addendum G)', () => {
    const barrels = {
      'lib/stores/index.ts': "export * from '../thing-store';\nexport * from './more';",
      // A cycle of barrels: resolution stops, it does not loop.
      'lib/stores/more.ts':
        "export * from './index';\nexport { saveThing as keepThing } from '../thing-store';",
      'app/components.ts':
        "export { UnresolvedForm as Drawn } from './UnresolvedQuarantine';\nexport * as fenced from '@/lib/fenced-submission';",
    };
    it.each([
      [
        'aliased hooks, boundary and component',
        edit(
          ["import { useCallback } from 'react';", "import { useCallback as memo } from 'react';"],
          ['useCallback(', 'memo('],
          [
            'import { submitThroughSlot, useSlotActionState }',
            'import { submitThroughSlot as through, useSlotActionState as useSlotState }',
          ],
          ['return submitThroughSlot({', 'return through({'],
          ['useSlotActionState(send, null)', 'useSlotState(send, null)'],
          ['import { UnresolvedForm }', 'import { UnresolvedForm as Drawn }'],
          ['<UnresolvedForm restore', '<Drawn restore'],
          ['</UnresolvedForm>', '</Drawn>'],
        ),
      ],
      [
        'namespace imports of React, the boundary, the store, the gate module and the actions',
        edit(
          ["import { useCallback } from 'react';", "import * as React from 'react';"],
          ['useCallback(', 'React.useCallback('],
          [
            "import { submitThroughSlot, useSlotActionState } from '@/lib/fenced-submission';",
            "import * as fenced from '@/lib/fenced-submission';",
          ],
          ['return submitThroughSlot({', 'return fenced.submitThroughSlot({'],
          ['useSlotActionState(send, null)', 'fenced.useSlotActionState(send, null)'],
          [
            "import { UnresolvedForm } from '@/app/UnresolvedQuarantine';",
            "import * as Q from '@/app/UnresolvedQuarantine';",
          ],
          ['<UnresolvedForm restore', '<Q.UnresolvedForm restore'],
          ['</UnresolvedForm>', '</Q.UnresolvedForm>'],
          [
            "import { answerThing, clearThing, restoreThing, saveThing, settleThing } from '@/lib/thing-store';",
            "import * as store from '@/lib/thing-store';",
          ],
          ['=> saveThing()', '=> store.saveThing()'],
          ['=> answerThing(state)', '=> store.answerThing(state)'],
          ['=> settleThing()', '=> store.settleThing()'],
          ['clearThing()', 'store.clearThing()'],
          ['restoreThing()', 'store.restoreThing()'],
          [
            "import { submitThing } from './thing-actions';",
            "import * as actions from './thing-actions';",
          ],
          ['=> submitThing(previous', '=> actions.submitThing(previous'],
        ),
      ],
      [
        'the default React import',
        edit(
          ["import { useCallback } from 'react';", "import React from 'react';"],
          ['useCallback(', 'React.useCallback('],
        ),
      ],
      [
        'the store, the component and the boundary through re-export barrels (a cycle among them)',
        edit(
          ["from '@/lib/thing-store'", "from '@/lib/stores'"],
          ['import { answerThing, clearThing,', 'import { answerThing, clearThing, keepThing,'],
          // A name no barrel exports: the whole cycle is walked, and the walk ends.
          [
            "from '@/lib/stores';",
            "from '@/lib/stores';\n    import type { NotExported } from '@/lib/stores';",
          ],
          ['remember: () => saveThing()', 'remember: () => keepThing()'],
          [
            "import { UnresolvedForm } from '@/app/UnresolvedQuarantine';",
            "import { Drawn, fenced } from '@/app/components';",
          ],
          ['<UnresolvedForm restore', '<Drawn restore'],
          ['</UnresolvedForm>', '</Drawn>'],
          ["import { submitThroughSlot, useSlotActionState } from '@/lib/fenced-submission';", ''],
          ['return submitThroughSlot({', 'return fenced.submitThroughSlot({'],
          ['useSlotActionState(send, null)', 'fenced.useSlotActionState(send, null)'],
        ),
      ],
      [
        'a local alias and a destructured member',
        edit(
          [
            "import { useCallback } from 'react';",
            "import * as React from 'react';\n    const { useCallback } = React;",
          ],
          [
            'return submitThroughSlot({',
            'const through = submitThroughSlot;\n          return through({',
          ],
        ),
      ],
    ] as const)('%s', (_label, form) => {
      expect(fencedForms(tree(form, barrels))).toEqual(['app/thing/ThingForm.tsx']);
      expect(fencedFormViolations(tree(form, barrels))).toEqual([]);
    });
  });

  describe('a bypass is refused however it is spelled', () => {
    it.each([
      [
        'its own thrown handler returning UNCONFIRMED (the r4 bypass)',
        edit([
          'return submitThroughSlot({',
          "try { await submitThing(previous, form); } catch (error) { return { kind: 'UNCONFIRMED' }; }\n          return submitThroughSlot({",
        ]),
        {},
        ['callback', 'completion', 'transport'],
      ],
      [
        'an early HELD returned before the boundary',
        edit([
          'return submitThroughSlot({',
          "if (retrying) return { kind: 'HELD' };\n          return submitThroughSlot({",
        ]),
        {},
        ['callback'],
      ],
      [
        'a .catch on the transport inside send',
        edit([
          'send: () => submitThing(previous, form),',
          "send: () => submitThing(previous, form).catch(() => ({ kind: 'UNCONFIRMED' })),",
        ]),
        {},
        ['completion'],
      ],
      [
        'the session probe or redirect test of its own',
        edit([
          "import { submitThroughSlot, useSlotActionState } from '@/lib/fenced-submission';",
          "import { submitThroughSlot, useSlotActionState } from '@/lib/fenced-submission';\n    import { isRedirect } from '@/lib/session-refusal';",
        ]),
        {},
        ['completion'],
      ],
      [
        'an answer made outside the boundary',
        edit([
          'return <button onClick={() => clearThing()} />;',
          'answerThing(state);\n      return <button />;',
        ]),
        {},
        ['store'],
      ],
      [
        'the transport called outside send',
        edit([
          'remember: () => saveThing(),',
          'remember: () => (submitThing(previous, form), saveThing()),',
        ]),
        {},
        ['transport'],
      ],
      [
        'a callback that is not the boundary at all',
        edit(['useSlotActionState(send, null)', 'useSlotActionState(async () => null, null)']),
        {},
        ['callback', 'boundary'],
      ],
      [
        'the gate drawn directly, without the restore path',
        edit(
          [
            'return <UnresolvedForm restore={() => restoreThing()}>{() => <Body />}</UnresolvedForm>;',
            'return <QuarantineGate><Body /></QuarantineGate>;',
          ],
          [
            "import { UnresolvedForm } from '@/app/UnresolvedQuarantine';",
            "import { QuarantineGate } from '@/app/UnresolvedQuarantine';",
          ],
        ),
        {},
        ['drawn', 'drawn', 'drawn'],
      ],
      [
        'no boundary at all',
        edit(
          [
            "import { submitThroughSlot, useSlotActionState } from '@/lib/fenced-submission';",
            "import { useSlotActionState } from '@/lib/fenced-submission';",
          ],
          ['return submitThroughSlot({', 'return Promise.resolve({'],
        ),
        {},
        ['boundary', 'callback', 'store', 'transport'],
      ],
      // Review 5, R7: the ordinary static spellings that used to escape.
      [
        "React's useActionState, aliased, with an unfinalized callback",
        edit(
          [
            "import { useCallback } from 'react';",
            "import { useCallback, useActionState as uas } from 'react';",
          ],
          ['useSlotActionState(send, null)', 'uas(async (p, form) => submitThing(p, form), null)'],
        ),
        {},
        ['state', 'callback', 'boundary', 'transport'],
      ],
      [
        "React's useActionState through a namespace import",
        edit(
          [
            "import { useCallback } from 'react';",
            "import * as React from 'react';\n    import { useCallback } from 'react';",
          ],
          ['useSlotActionState(send, null)', 'React.useActionState(send, null)'],
        ),
        {},
        ['state'],
      ],
      [
        'the slot factory aliased, in an app-local store whose writer is re-exported under another name',
        edit(
          ["from '@/lib/thing-store'", "from './thing-local'"],
          ['import { answerThing, clearThing,', 'import { answerThing, keepAside, clearThing,'],
          [
            'return <button onClick={() => clearThing()} />;',
            'keepAside(state);\n      return <button />;',
          ],
        ),
        {
          'app/thing/thing-local.ts': STORE.replace(
            "import { fencedSlot } from './unresolved-tenancy';\n    const slot = fencedSlot(",
            "import { fencedSlot as slotFor } from '@/lib/unresolved-tenancy';\n    const slot = slotFor(",
          ).concat('\nexport const keepAside = answerThing;'),
        },
        ['store'],
      ],
      [
        'the slot factory through a namespace import, the store through a barrel, its writer aliased outside the boundary',
        edit(
          ["from '@/lib/thing-store'", "from '@/lib/barrel'"],
          ['import { answerThing, clearThing,', 'import { answerThing as note, clearThing,'],
          ['answer: (state) => answerThing(state),', 'answer: (state) => note(state),'],
          [
            'return <button onClick={() => clearThing()} />;',
            'note(state);\n      return <button />;',
          ],
        ),
        {
          'lib/thing-store.ts': STORE.replace(
            "import { fencedSlot } from './unresolved-tenancy';\n    const slot = fencedSlot(",
            "import * as tenancy from './unresolved-tenancy';\n    const slot = tenancy.fencedSlot(",
          ),
          'lib/barrel.ts': "export * from './thing-store';",
        },
        ['store'],
      ],
      [
        'a namespace store writer outside the boundary',
        edit(
          [
            "import { answerThing, clearThing, restoreThing, saveThing, settleThing } from '@/lib/thing-store';",
            "import { answerThing, clearThing, restoreThing, saveThing, settleThing } from '@/lib/thing-store';\n    import * as store from '@/lib/thing-store';",
          ],
          [
            'return <button onClick={() => clearThing()} />;',
            'store.settleThing();\n      return <button />;',
          ],
        ),
        {},
        ['store'],
      ],
      [
        "a 'use server' module's action, whatever the module is called, outside send",
        edit(
          [
            "import { submitThing } from './thing-actions';",
            "import { submitThing } from './thing-actions';\n    import { sendThing } from './send-thing';",
          ],
          ['remember: () => saveThing(),', 'remember: () => (sendThing(form), saveThing()),'],
        ),
        { 'app/thing/send-thing.ts': "'use server';\nexport async function sendThing() {}" },
        ['transport'],
      ],
      [
        'a namespace action call outside send',
        edit(
          [
            "import { submitThing } from './thing-actions';",
            "import * as actions from './thing-actions';",
          ],
          [
            'send: () => submitThing(previous, form),',
            'send: () => actions.submitThing(previous, form),',
          ],
          [
            'remember: () => saveThing(),',
            'remember: () => (actions.submitThing(previous, form), saveThing()),',
          ],
        ),
        {},
        ['transport'],
      ],
      [
        'the completion helpers aliased or through a namespace',
        edit(
          [
            "import { submitThing } from './thing-actions';",
            "import { submitThing } from './thing-actions';\n    import * as session from '@/lib/session-refusal';\n    import { isRedirect as redirected } from '@/lib/session-refusal';",
          ],
          [
            'failed: () => null,',
            'failed: () => (session.sessionHasEnded(), redirected(null), null),',
          ],
        ),
        {},
        ['completion'],
      ],
      [
        'the gate aliased, drawn instead of UnresolvedForm',
        edit(
          [
            "import { UnresolvedForm } from '@/app/UnresolvedQuarantine';",
            "import { QuarantineGate as Gate } from '@/app/UnresolvedQuarantine';",
          ],
          [
            'return <UnresolvedForm restore={() => restoreThing()}>{() => <Body />}</UnresolvedForm>;',
            'return <Gate><Body /></Gate>;',
          ],
        ),
        {},
        ['drawn'],
      ],
      [
        'a slot made in the form itself',
        edit([
          "import { submitThing } from './thing-actions';",
          "import { submitThing } from './thing-actions';\n    import { fencedSlot } from '@/lib/unresolved-tenancy';\n    const own = fencedSlot('q.');",
        ]),
        {},
        ['store'],
      ],
    ] as const)('%s', (_label, form, extra, expected) => {
      expect(form).not.toBe(COMPLIANT);
      expect(fencedForms(tree(form, extra))).toEqual(['app/thing/ThingForm.tsx']);
      expect([...new Set(rules(form, extra))].sort()).toEqual([...new Set(expected)].sort());
    });
  });

  it('QuarantineGate drawn by any other file is refused, also aliased or through a barrel', () => {
    expect(
      rules(COMPLIANT, {
        'app/other/Other.tsx':
          "import { QuarantineGate } from '@/app/UnresolvedQuarantine';\nexport const X = () => <QuarantineGate />;",
        'app/other/Aliased.tsx':
          "import { QuarantineGate as G } from '@/app/UnresolvedQuarantine';\nexport const Y = () => <G />;",
        'app/other/barrel.ts': "export * from '@/app/UnresolvedQuarantine';",
        'app/other/Barrelled.tsx':
          "import * as B from './barrel';\nexport const Z = () => <B.QuarantineGate />;",
      }),
    ).toEqual(['drawn', 'drawn', 'drawn']);
  });
});
