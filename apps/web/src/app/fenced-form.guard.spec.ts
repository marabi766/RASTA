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

  it('finds the eight stores built on fencedSlot, and their eight forms', () => {
    expect([...fencedModules(sources)].sort()).toEqual([
      'lib/unresolved-bid.ts',
      'lib/unresolved-contract-command.ts',
      'lib/unresolved-dispute.ts',
      'lib/unresolved-inventory.ts',
      'lib/unresolved-marker.ts',
      'lib/unresolved-order.ts',
      'lib/unresolved-return.ts',
      'lib/unresolved-statement.ts',
      'lib/unresolved-tender-command.ts',
    ]);
    expect(fencedForms(sources)).toEqual([
      'app/contracts/[id]/ContractCommandForm.tsx',
      'app/contracts/[id]/StatementCommandForm.tsx',
      'app/inventory/InventoryCommandForm.tsx',
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
  /** Code, not prose: comments may name what they describe. */
  const code = (text: string) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .join('\n');

  it('PR 363 review 4: only the slot makes a send identity — no constant, count or cast anywhere else', () => {
    const offenders = [...sources]
      // Test helpers (`src/test/`) only read back what a slot wrote.
      .filter(([file]) => file !== 'lib/unresolved-tenancy.ts' && !file.startsWith('test/'))
      .filter(([, text]) => /\bas Attempt\b|\bFIRST_ATTEMPT\b|<Attempt>/.test(code(text)))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
    const tenancy = code(sources.get('lib/unresolved-tenancy.ts')!);
    // The one mint, and the reading of one an entry already carries.
    expect(tenancy.match(/\bas Attempt\b/g)).toHaveLength(2);
    expect(tenancy).toContain('return text as Attempt;');
    expect(tenancy).toContain('(attempt as Attempt)');
    expect(tenancy.match(/\bmintAttempt\(\)/g)).toHaveLength(3);
    expect(tenancy).not.toMatch(/FIRST_ATTEMPT|\+ 1 as Attempt|attempt \?\? /);
  });

  it('a set-aside link is wired by setAsideOnOpen only: no form handles auxclick itself (a right-click fires it too)', () => {
    const own = [...sources]
      .filter(([file]) => file !== 'lib/set-aside-link.ts')
      .filter(([, text]) => /onAuxClick|auxclick/i.test(code(text)))
      .map(([file]) => file);
    expect(own).toEqual([]);
    const forms = fencedForms(sources);
    expect(forms).toHaveLength(8);
    for (const form of forms) {
      expect({ form, wired: /\{\.\.\.setAsideOnOpen\(/.test(code(sources.get(form)!)) }).toEqual({
        form,
        wired: true,
      });
    }
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

  describe('review 6 R7: one binding graph', () => {
    const storeImport =
      "import { answerThing, clearThing, restoreThing, saveThing, settleThing } from '@/lib/thing-store';";
    const barrels = [
      ["import { saveThing } from './thing-store'; export { saveThing };", 'B.saveThing'],
      [
        "import { saveThing } from './thing-store'; const keep = saveThing; export { keep };",
        'B.keep',
      ],
      ["import * as store from './thing-store'; export { store };", 'B.store.saveThing'],
    ] as const;
    it.each(barrels)('store discovery through %s', (barrel, writer) => {
      const extra = { 'lib/barrel.ts': barrel };
      const imports = "import * as B from '@/lib/barrel';";
      const valid = COMPLIANT.replace(storeImport, imports)
        .replaceAll('saveThing()', `${writer}()`)
        .replaceAll('answerThing(state)', 'null')
        .replaceAll('settleThing()', 'null')
        .replaceAll('clearThing()', 'null')
        .replaceAll('restoreThing()', 'null');
      const invalid = `${imports}
        import { useActionState } from 'react';
        export const Form = () => useActionState(() => ${writer}(), null);`;
      expect(fencedForms(tree(valid, extra))).toEqual(['app/thing/ThingForm.tsx']);
      expect(rules(valid, extra)).toEqual([]);
      expect(fencedForms(tree(invalid, extra))).toEqual(['app/thing/ThingForm.tsx']);
      expect(rules(invalid, extra)).toEqual(expect.arrayContaining(['state', 'store']));
    });

    it.each([
      ['named', "import { QuarantineGate as Gate } from '@/lib/gates';", 'Gate'],
      [
        'named alias',
        "import { QuarantineGate } from '@/lib/gates'; const Gate = QuarantineGate;",
        'Gate',
      ],
      ['namespace', "import * as Q from '@/lib/gates';", 'Q.QuarantineGate'],
      [
        'namespace alias',
        "import * as Q from '@/lib/gates'; const Gate = Q.QuarantineGate;",
        'Gate',
      ],
    ])('global gate through import-then-export: %s', (_label, imports, tag) => {
      const extra = {
        'lib/gates.ts':
          "import { QuarantineGate, UnresolvedForm } from '@/app/UnresolvedQuarantine'; export { QuarantineGate, UnresolvedForm };",
      };
      expect(rules(`${imports} export const Form = () => <${tag} />;`, extra)).toEqual(['drawn']);
      expect(
        rules(
          `${imports.replaceAll('QuarantineGate', 'UnresolvedForm')} export const Form = () => <${tag.replaceAll('QuarantineGate', 'UnresolvedForm')} />;`,
          extra,
        ),
      ).toEqual([]);
    });

    for (const method of ['start', 'answer', 'settle']) {
      it.each([
        ['local alias', `const write = slot.${method};`, 'write'],
        ['destructuring', `const { ${method} } = slot;`, method],
        ['renamed destructuring', `const { ${method}: write } = slot;`, 'write'],
      ])(`slot ${method} through %s`, (_label, binding, write) => {
        const extra = { 'lib/thing-store.ts': `${STORE} export { slot };` };
        const form = COMPLIANT.replace(
          storeImport,
          `${storeImport} import { slot } from '@/lib/thing-store'; ${binding}`,
        );
        expect(
          rules(form.replace('remember: () => saveThing()', `remember: () => ${write}()`), extra),
        ).toEqual([]);
        expect(rules(`${form} ${write}();`, extra)).toEqual(['store']);
      });
    }

    it('follows nested exported namespaces, local destructured exports and barrel cycles', () => {
      const extra = {
        'lib/inner.ts':
          "import * as store from './thing-store'; const { saveThing: keep } = store; export { keep }; export * from './outer';",
        'lib/outer.ts': "import * as inner from './inner'; export { inner };",
      };
      const valid = COMPLIANT.replace(
        storeImport,
        `${storeImport} import { inner } from '@/lib/outer';`,
      ).replace('remember: () => saveThing()', 'remember: () => inner.keep()');
      expect(rules(valid, extra)).toEqual([]);
      expect(rules(`${valid} inner.keep();`, extra)).toEqual(['store']);
      const invalid =
        "import { inner } from '@/lib/outer'; import { useActionState } from 'react'; useActionState(() => inner.keep(), null);";
      expect(fencedForms(tree(invalid, extra))).toEqual(['app/thing/ThingForm.tsx']);
      expect(rules(invalid, extra)).toEqual(expect.arrayContaining(['state', 'store']));
    });

    it('keeps a missing named re-export of a store fail closed', () => {
      const extra = { 'lib/broken.ts': "export { missing } from './thing-store';" };
      const form =
        "import { missing } from '@/lib/broken'; import { useActionState } from 'react'; useActionState(() => null, null);";
      expect(fencedForms(tree(form, extra))).toEqual(['app/thing/ThingForm.tsx']);
      expect(rules(form, extra)).toContain('state');
    });

    it.each([
      'export default function () { return fencedSlot(); }',
      'export default () => fencedSlot();',
    ])('anonymous default factory: %s', (factory) => {
      const extra = {
        'lib/factory.ts': `import { fencedSlot } from './unresolved-tenancy'; ${factory}`,
        'lib/thing-store.ts': STORE.replace(
          "import { fencedSlot } from './unresolved-tenancy';",
          "import fencedSlot from './factory';",
        ),
      };
      expect(fencedModules(tree(COMPLIANT, extra)).has('lib/thing-store.ts')).toBe(true);
      expect(fencedForms(tree(COMPLIANT, extra))).toEqual(['app/thing/ThingForm.tsx']);
      expect(rules(COMPLIANT, extra)).toEqual([]);
      expect(rules(`${COMPLIANT} saveThing();`, extra)).toEqual(['store']);
    });
  });

  describe('FU-037: every static alias resolves through the one normalizer', () => {
    const storeImport =
      "import { answerThing, clearThing, restoreThing, saveThing, settleThing } from '@/lib/thing-store';";
    const writeThrough = (alias: string, imports: string, writer: string) => {
      const extra = { 'lib/alias.ts': alias };
      const valid = COMPLIANT.replace(storeImport, `${storeImport} ${imports}`).replace(
        'remember: () => saveThing()',
        `remember: () => ${writer}()`,
      );
      expect(rules(valid, extra)).toEqual([]);
      expect(rules(`${valid} ${writer}();`, extra)).toEqual(['store']);
    };
    const own =
      "import * as store from './thing-store'; import { saveThing } from './thing-store';";
    it.each([
      ['default-export member', `${own} export default { saveThing };`, 'D', 'D.saveThing'],
      [
        'default-export renamed member',
        `${own} export default { keep: saveThing };`,
        'D',
        'D.keep',
      ],
      [
        'nested default-export member',
        `${own} export default { store };`,
        'D',
        'D.store.saveThing',
      ],
      ['parenthesized default export', `${own} export default (saveThing);`, 'keep', 'keep'],
      ['asserted default export', `${own} export default saveThing as () => void;`, 'keep', 'keep'],
      [
        'satisfies alias',
        `${own} const keep = saveThing satisfies unknown; export default keep;`,
        'keep',
        'keep',
      ],
      [
        'inline export destructuring',
        `${own} export const { saveThing: keep } = store;`,
        '{ keep }',
        'keep',
      ],
      [
        'generic-instantiation alias',
        `${own} const keep = saveThing<never>; export { keep };`,
        '{ keep }',
        'keep',
      ],
      ['literal element access', `${own} export { store };`, '{ store }', "store['saveThing']"],
      // A `.ts` file read as TSX took `<T>` for JSX and lost every export after it.
      [
        'an export after a type assertion in a .ts barrel',
        `const id = <T>(x: unknown) => x as T; export { saveThing as keep } from './thing-store';`,
        '{ keep }',
        'keep',
      ],
    ])('%s', (_label, alias, binding, writer) =>
      writeThrough(alias, `import ${binding} from '@/lib/alias';`, writer),
    );

    it("React's useActionState through a generic-instantiation alias is found and refused", () => {
      const form =
        "import { saveThing } from '@/lib/thing-store'; import { useActionState } from 'react'; const uas = (useActionState<unknown, FormData>); export const Form = () => uas(() => saveThing(), null);";
      expect(fencedForms(tree(form))).toEqual(['app/thing/ThingForm.tsx']);
      expect(rules(form)).toEqual(expect.arrayContaining(['state', 'store']));
    });

    it('wrapped boundary, callback and completion handlers are read through', () => {
      const valid = COMPLIANT.replace('return submitThroughSlot({', 'return (submitThroughSlot(({')
        .replace(
          'failed: () => null,\n          });',
          'failed: () => null,\n          }) as never)) as never;',
        )
        .replace('useSlotActionState(send, null)', 'useSlotActionState((send as never), null)');
      expect(rules(valid)).toEqual([]);
      for (const handler of [
        '(submitThing(previous, form).catch)',
        "submitThing(previous, form)['then']",
      ]) {
        const bypass = valid.replace(
          'send: () => submitThing(previous, form),',
          `send: () => ${handler}(() => null),`,
        );
        expect(rules(bypass)).toEqual(['completion']);
      }
    });

    it.each([
      [
        'parenthesized and asserted',
        'export const make = ((p) => fencedSlot(p)) as typeof fencedSlot;',
        "import { make } from './factory'; const slot = make(",
      ],
      [
        'satisfies, default',
        'export default (function () { return fencedSlot(); }) satisfies unknown;',
        "import make from './factory'; const slot = make(",
      ],
      [
        'an alias of a definition',
        'const build = () => fencedSlot(); const make = build; export { make };',
        "import { make } from './factory'; const slot = make(",
      ],
      [
        'an object member',
        'export default { make: () => fencedSlot() };',
        "import F from './factory'; const slot = F.make(",
      ],
    ])('a factory defined %s is found at its definition', (_label, factory, use) => {
      const extra = {
        'lib/factory.ts': `import { fencedSlot } from './unresolved-tenancy'; ${factory}`,
        'lib/thing-store.ts': STORE.replace(
          "import { fencedSlot } from './unresolved-tenancy';\n    const slot = fencedSlot(",
          use,
        ),
      };
      expect(fencedModules(tree(COMPLIANT, extra)).has('lib/thing-store.ts')).toBe(true);
      expect(rules(COMPLIANT, extra)).toEqual([]);
      expect(rules(`${COMPLIANT} saveThing();`, extra)).toEqual(['store']);
    });

    describe('PR 698 r1 F1: an invocation adapter invokes its target, never replaces it', () => {
      const store = { 'lib/thing-store.ts': `${STORE} export { slot };` };
      const aliases = {
        ...store,
        'lib/alias.ts':
          "import { saveThing, answerThing, settleThing, slot } from './thing-store'; export default { saveThing, answerThing, settleThing, slot };",
      };
      const spellings: [string, string, (name: string) => string][] = [
        ['direct import', "import { slot } from '@/lib/thing-store';", (n) => n],
        ['namespace', "import * as S from '@/lib/thing-store';", (n) => `S.${n}`],
        ['default-object alias', "import D from '@/lib/alias';", (n) => `D.${n}`],
      ];
      const adapters: [string, (fn: string) => string][] = [
        ['.call', (fn) => `${fn}.call(null)`],
        ['.apply', (fn) => `${fn}.apply(null, [])`],
        ['.bind()()', (fn) => `${fn}.bind(null)()`],
        ['Reflect.apply', (fn) => `Reflect.apply(${fn}, null, [])`],
      ];
      const targets = [
        ...['saveThing', 'answerThing', 'settleThing'],
        ...['start', 'answer', 'settle'].map((m) => `slot.${m}`),
      ];
      const cases = spellings.flatMap(([spelling, imports, name]) =>
        adapters.flatMap(([adapter, invoke]) =>
          targets.map((target) => [
            `${adapter} of ${target} (${spelling})`,
            imports,
            invoke(name(target)),
          ]),
        ),
      );
      it.each(cases)('%s is refused outside the boundary', (_label, imports, write) => {
        expect(rules(`${COMPLIANT} ${imports} ${write};`, aliases)).toEqual(['store']);
      });
      it.each(cases.filter(([, , write]) => !write.includes('slot')))(
        '%s passes inside the boundary',
        (_label, imports, write) => {
          const valid = COMPLIANT.replace(
            'remember: () => saveThing()',
            `remember: () => ${write}`,
          );
          expect(rules(`${valid} ${imports}`, aliases)).toEqual([]);
        },
      );
      it('a hook or a factory behind an adapter is still found', () => {
        const hook =
          "import { saveThing } from '@/lib/thing-store'; import { useActionState } from 'react'; export const Form = () => useActionState.call(null, () => saveThing(), null);";
        expect(fencedForms(tree(hook))).toEqual(['app/thing/ThingForm.tsx']);
        expect(rules(hook)).toEqual(expect.arrayContaining(['state', 'store']));
        const made = {
          'lib/thing-store.ts': STORE.replace("fencedSlot('p.'", "fencedSlot.apply(null, ['p.']"),
        };
        expect(fencedModules(tree(COMPLIANT, made)).has('lib/thing-store.ts')).toBe(true);
        expect(rules(`${COMPLIANT} saveThing.call(null);`, made)).toEqual(['store']);
        // A bound writer kept aside is the writer.
        expect(rules(`${COMPLIANT} const kept = saveThing.bind(null); kept();`)).toEqual(['store']);
      });
    });

    describe('FU-071: one provenance for adapters — own members stay own, composed adapters invoke their target', () => {
      // #1 (regression of PR 698 r2): a module's own `call`/`apply` member is itself, not an adapter.
      const owns = ['call', 'apply'].flatMap((name) =>
        [`${name}(p) { return fencedSlot(p); }`, `${name}: (p) => fencedSlot(p)`].flatMap(
          (member) =>
            [
              `export default { ${member} };`,
              `const api = { ${member} }; export default api;`,
            ].flatMap((exported) =>
              ['ts', 'tsx'].map((ext) => [`${exported} (.${ext})`, name, exported, ext] as const),
            ),
        ),
      );
      it.each(owns)('an own factory member %s is found', (_label, name, exported, ext) => {
        const extra = {
          [`lib/factory.${ext}`]: `import { fencedSlot } from './unresolved-tenancy'; ${exported}`,
          'lib/thing-store.ts': STORE.replace(
            "import { fencedSlot } from './unresolved-tenancy';\n    const slot = fencedSlot(",
            `import F from './factory'; const slot = F.${name}(`,
          ),
        };
        expect(fencedModules(tree(COMPLIANT, extra)).has('lib/thing-store.ts')).toBe(true);
        expect(fencedForms(tree(COMPLIANT, extra))).toEqual(['app/thing/ThingForm.tsx']);
        expect(rules(COMPLIANT, extra)).toEqual([]);
        expect(rules(`${COMPLIANT} saveThing();`, extra)).toEqual(['store']);
      });

      // #2: composed, kept, aliased and bound adapters.
      const composed = [
        'saveThing.call.bind(saveThing)(null)',
        'Reflect.apply.apply(null, [saveThing, null, []])',
        'Reflect.apply.call.apply(Reflect.apply, [null, saveThing, null, []])',
        'Function.prototype.call.call(saveThing, null)',
        'Function.prototype.bind.call(saveThing, null)()',
        'Reflect.apply.bind(null, saveThing)(null, [])',
        'Reflect.apply.bind(null, saveThing, null)([])',
        'globalThis.Reflect.apply(saveThing, null, [])',
        '(0, Reflect.apply)(saveThing, null, [])',
      ];
      // Already refused at 8c945408 (PR 698 r2); kept so the provenance rewrite cannot lose them.
      const guarded = [
        'Reflect.apply.call(null, saveThing, null, [])',
        'saveThing.bind(null).call(null)',
        '(Reflect.apply as never)(saveThing, null, [])',
      ];
      const kept = [
        'const run = Reflect.apply; run(saveThing, null, []);',
        'const R = Reflect; R.apply(saveThing, null, []);',
        'const { apply } = Reflect; apply(saveThing, null, []);',
        'const { apply: run } = Reflect; run(saveThing, null, []);',
        'const R = Reflect; const { apply: run } = R; run(saveThing, null, []);',
        'const c = saveThing.call; c.call(saveThing, null);',
        'const a = saveThing.apply; a.call(saveThing, null, []);',
        'const c = Function.prototype.call; c.apply(saveThing, [null]);',
        'const b = saveThing.call.bind(saveThing); b(null);',
        'const b = Reflect.apply.bind(null, saveThing); b(null, []);',
      ];
      it.each([...[...composed, ...guarded].map((c) => `${c};`), ...kept])(
        '%s is refused outside the boundary',
        (write) => {
          expect(rules(`${COMPLIANT} ${write}`)).toEqual(['store']);
        },
      );
      it.each([...composed, ...guarded])('%s passes inside the boundary', (write) => {
        expect(
          rules(COMPLIANT.replace('remember: () => saveThing()', `remember: () => ${write}`)),
        ).toEqual([]);
      });
      it('an adapter whose function or arguments cannot be read is refused (fail closed)', () => {
        for (const write of [
          'const c = saveThing.call; c(null);',
          'Reflect.apply(...xs);',
          'Reflect.construct(saveThing, []);',
          'const { construct } = Reflect; construct(saveThing, []);',
        ]) {
          expect({ write, rules: rules(`${COMPLIANT} ${write}`) }).toEqual({
            write,
            rules: ['unresolved'],
          });
        }
      });
      it('bound arguments reach the target: the hook, the boundary and a factory', () => {
        const valid = COMPLIANT.replace(
          'useSlotActionState(send, null)',
          'useSlotActionState.bind(null, send)(null)',
        );
        expect(rules(valid)).toEqual([]);
        const react = valid.replace(
          'useSlotActionState.bind(null, send)(null)',
          'Reflect.apply.bind(null, useActionState, null)([send, null])',
        );
        expect(rules(`import { useActionState } from 'react'; ${react}`)).toEqual(['state']);
        const made = {
          'lib/thing-store.ts': STORE.replace(
            "fencedSlot('p.'",
            "Reflect.apply.bind(null, fencedSlot).call(null, null, ['p.']), fencedSlot('p.'",
          ),
        };
        expect(fencedModules(tree(COMPLIANT, made)).has('lib/thing-store.ts')).toBe(true);
        const only = {
          'lib/thing-store.ts': STORE.replace(
            "import { fencedSlot } from './unresolved-tenancy';",
            "import { fencedSlot as f } from './unresolved-tenancy'; const fencedSlot = f.call.bind(f, null);",
          ),
        };
        expect(fencedModules(tree(COMPLIANT, only)).has('lib/thing-store.ts')).toBe(true);
        expect(fencedForms(tree(COMPLIANT, only))).toEqual(['app/thing/ThingForm.tsx']);
      });
    });

    describe('PR 724 r2: bound provenance, effective arguments and comma aliases', () => {
      const formPath = 'app/thing/ThingForm.tsx';
      const hook = "import { useSlotActionState } from '@/lib/fenced-submission';";
      const writers = [
        'slot.start.bind(slot)',
        'Reflect.apply.bind(null, slot.start, slot, [])',
        'slot.start.call.bind(slot.start, slot)',
      ];
      it.each(
        [
          ['named', "export { saveThing } from './thing-store';", '{ saveThing }', 'saveThing'],
          [
            'default',
            "export { saveThing as default } from './thing-store';",
            'saveThing',
            'saveThing',
          ],
          [
            'local export',
            "import { saveThing as s } from './thing-store'; export { s as saveThing };",
            '{ saveThing }',
            'saveThing',
          ],
          [
            'local namespace export',
            "import { saveThing } from './thing-store'; export { saveThing };",
            '* as S',
            'S.saveThing',
          ],
          ['star barrel', "export * from './thing-store';", '* as S', 'S.saveThing'],
          [
            'named namespace barrel',
            "export { saveThing } from './thing-store';",
            '* as S',
            'S.saveThing',
          ],
        ].flatMap((row) =>
          writers.map((bound) => [`${row[0]} (${bound})`, ...row.slice(1), bound]),
        ),
      )('F1 discovers a bound writer through %s', (_label, barrel, names, writer, bound) => {
        const form = `${hook} import ${names} from '@/lib/exports'; useSlotActionState(() => ${writer}(), null);`;
        const sources = tree(form, {
          'lib/thing-store.ts': STORE.replace('() => slot.start()', bound),
          'lib/exports.ts': barrel,
        });
        expect(fencedForms(sources)).toEqual([formPath]);
        expect(fencedFormViolations(sources).map((v) => v.rule)).toEqual(
          expect.arrayContaining(['callback', 'boundary', 'store', 'drawn']),
        );
      });
      it.each(['isRedirect', 'sessionHasEnded'])(
        'F1 keeps bound %s completion provenance',
        (name) => {
          const extra = {
            'lib/check.ts': `import { ${name} } from './session-refusal'; export const check = ${name}.bind(null).bind(null);`,
          };
          expect(
            rules(`${COMPLIANT} import { check } from '@/lib/check'; check;`, extra),
          ).toContain('completion');
          expect(rules(`${COMPLIANT} import * as C from '@/lib/check'; C.check;`, extra)).toContain(
            'completion',
          );
        },
      );
      it.each(['local', 'imported'])('F1 checks %s bound JSX inside and outside forms', (where) => {
        const extra = {
          'lib/draw.ts':
            "import { UnresolvedForm, QuarantineGate } from '@/app/UnresolvedQuarantine'; export const Draw = UnresolvedForm.bind(null); export const Gate = QuarantineGate.bind(null).bind(null);",
        };
        const imports =
          where === 'local'
            ? "import { QuarantineGate } from '@/app/UnresolvedQuarantine'; const Gate = QuarantineGate.bind(null);"
            : "import { Gate } from '@/lib/draw';";
        const valid = COMPLIANT.replace(
          "import { UnresolvedForm } from '@/app/UnresolvedQuarantine';",
          "import { Draw as UnresolvedForm } from '@/lib/draw';",
        );
        expect(rules(valid, extra)).toEqual([]);
        expect(rules(`${COMPLIANT} ${imports} const Bad = () => <Gate />;`, extra)).toContain(
          'drawn',
        );
        const sources = tree(COMPLIANT, {
          ...extra,
          'app/Other.tsx': `${imports} const Bad = () => <Gate />;`,
        });
        expect(fencedFormViolations(sources)).toEqual([
          {
            file: 'app/Other.tsx',
            rule: 'drawn',
            detail: 'draws QuarantineGate outside UnresolvedForm',
          },
        ]);
      });

      const adapters: [string, (f: string, receiver: string, args: string[]) => string][] = [
        ['call', (f, r, a) => `${f}.call(${r}, ${a.join(', ')})`],
        ['apply', (f, r, a) => `${f}.apply(${r}, [${a.join(', ')}])`],
        ['Reflect.apply', (f, r, a) => `Reflect.apply(${f}, ${r}, [${a.join(', ')}])`],
        ['bound', (f, r, a) => `${f}.bind(${r}, ${a.join(', ')})()`],
        ['composed', (f, r, a) => `${f}.call.bind(${f}, ${r})(${a.join(', ')})`],
        ['kept', (f, r, a) => `kept.call(${f}, ${r}, ${a.join(', ')})`],
        ['Function.call', (f, r, a) => `Function.prototype.call.call(${f}, ${r}, ${a.join(', ')})`],
      ];
      const reducer = '() => submitThroughSlot({})';
      const replaceReducer = (expr: string) =>
        COMPLIANT.replace(/const send = useCallback\([\s\S]*?\n {6}\);/, `const send = ${expr};`);
      it.each(adapters)(
        'F2 reads the effective useCallback reducer through %s',
        (_label, invoke) => {
          const imports = 'const kept = useCallback.call;';
          const invalid = replaceReducer(
            invoke('useCallback', reducer, ["() => ({ kind: 'HELD' })", '[]']),
          );
          expect(rules(`${invalid} ${imports}`)).toEqual(
            expect.arrayContaining(['callback', 'boundary']),
          );
          const valid = replaceReducer(invoke('useCallback', 'null', [reducer, '[]']));
          expect(rules(`${valid} ${imports}`)).toEqual([]);
        },
      );
      it('F2 refuses a reducer whose effective bound argument belongs to another module', () => {
        const extra = {
          'lib/memo.ts': `import { useCallback } from 'react'; import { submitThroughSlot } from './fenced-submission'; export const memo = useCallback.bind(() => submitThroughSlot({}), () => ({ kind: 'HELD' }));`,
        };
        const form = replaceReducer('memo([])');
        expect(rules(`${form} import { memo } from '@/lib/memo';`, extra)).toEqual(
          expect.arrayContaining(['callback', 'boundary']),
        );
      });
      it.each(adapters)(
        'F2 protects effective boundary options through %s, never the receiver',
        (_label, invoke) => {
          const imports = 'const kept = submitThroughSlot.call;';
          const receiver = '{ send: submitThing(previous, form), remember: saveThing() }';
          const replaceBoundary = (r: string) =>
            COMPLIANT.replace(
              /return submitThroughSlot\(([\s\S]*?)\);/,
              (_match, options: string) => `return ${invoke('submitThroughSlot', r, [options])};`,
            );
          expect(rules(`${replaceBoundary('null')} ${imports}`)).toEqual([]);
          expect(rules(`${replaceBoundary(receiver)} ${imports}`)).toEqual(
            expect.arrayContaining(['transport', 'store']),
          );
        },
      );
      it('F2 protects kept bound options at their source, not the ignored receiver', () => {
        const form = COMPLIANT.replace(
          'return submitThroughSlot({',
          'const through = submitThroughSlot.bind({ send: submitThing(previous, form), remember: saveThing() }, {',
        ).replace(
          'failed: () => null,\n          });',
          'failed: () => null,\n          }); return through();',
        );
        expect(rules(form)).toEqual(expect.arrayContaining(['transport', 'store']));
        expect(
          rules(
            form.replace('{ send: submitThing(previous, form), remember: saveThing() }', 'null'),
          ),
        ).toEqual([]);
      });

      const commas = [
        ['writer', '(0, saveThing)', 'run()'],
        ['Reflect.apply', '(0, Reflect.apply)', 'run(saveThing, null, [])'],
        ['Reflect', '(0, Reflect)', 'run.apply(saveThing, null, [])'],
        ['kept call', '(0, saveThing.call)', 'run.call(saveThing, null)'],
      ];
      it.each(commas)(
        'F3 follows comma aliases of %s locally and through named/namespace exports',
        (_label, value, invoke) => {
          expect(rules(`${COMPLIANT} const run = ${value}; ${invoke};`)).toEqual(['store']);
          const extra = {
            'lib/comma.ts': `import { saveThing } from './thing-store'; export const run = ${value};`,
          };
          for (const [imports, call] of [
            ["import { run } from '@/lib/comma';", invoke],
            ["import * as C from '@/lib/comma';", invoke.replace('run', 'C.run')],
          ])
            expect(rules(`${COMPLIANT} ${imports} ${call};`, extra)).toEqual(['store']);
        },
      );
      it('F3 discovers comma-aliased hooks and reads comma-wrapped reducers', () => {
        const form = `${hook} import { saveThing } from '@/lib/thing-store'; const state = (0, useSlotActionState); state((0, () => saveThing()), null);`;
        expect(fencedForms(tree(form))).toEqual([formPath]);
        expect(rules(form)).toEqual(expect.arrayContaining(['callback', 'boundary', 'store']));
        expect(rules(replaceReducer('useCallback((0, () => submitThroughSlot({})), [])'))).toEqual(
          [],
        );
      });
      it('F3 still scans eager comma operands outside effective options', () => {
        const form = COMPLIANT.replace(
          'return submitThroughSlot({',
          'return submitThroughSlot((saveThing(), submitThing(previous, form), {',
        ).replace('failed: () => null,\n          });', 'failed: () => null,\n          }));');
        expect(rules(form)).toEqual(expect.arrayContaining(['store', 'transport']));
      });
      it.each(['call', 'apply', 'bind'])(
        'F3 keeps comma-detached .%s receivers detached',
        (adapter) => {
          const form = COMPLIANT.replace(
            'return submitThroughSlot({',
            `return (0, submitThroughSlot.${adapter})(null, ${adapter === 'apply' ? '[' : ''}{`,
          )
            .replace('remember: () => saveThing()', 'remember: (saveThing(), () => saveThing())')
            .replace(
              'failed: () => null,\n          });',
              `failed: () => null,\n          }${adapter === 'apply' ? ']' : ''});`,
            );
          expect(rules(form)).toEqual(expect.arrayContaining(['callback', 'boundary', 'store']));
        },
      );
      it.each(['ts', 'tsx'])('F3 discovers comma-wrapped default factories in .%s', (ext) => {
        const extra = {
          [`lib/factory.${ext}`]:
            "import { fencedSlot } from './unresolved-tenancy'; export default (0, (p) => fencedSlot(p));",
          'lib/thing-store.ts': STORE.replace(
            "import { fencedSlot } from './unresolved-tenancy';",
            "import fencedSlot from './factory';",
          ),
        };
        expect(fencedModules(tree(COMPLIANT, extra)).has('lib/thing-store.ts')).toBe(true);
        expect(fencedForms(tree(COMPLIANT, extra))).toEqual([formPath]);
        expect(rules(`${COMPLIANT} saveThing();`, extra)).toEqual(['store']);
      });
    });

    describe('FU-106: returned expressions and bound inline functions', () => {
      const boundary = 'submitThroughSlot({})';
      const reducer = (body: string) =>
        COMPLIANT.replace(
          /const send = useCallback\([\s\S]*?\n {6}\);/,
          `const send = useCallback(async (previous, form) => ${body}, []);`,
        );

      const inlineStore = (target: string) => ({
        'lib/inline-store.ts': `import { fencedSlot } from './unresolved-tenancy';
          const slot = fencedSlot('inline.'); export const G = (${target}).bind(null);`,
      });
      const importG = "import { G } from '@/lib/inline-store';";

      it.each(['slot.start()', "fencedSlot('j.')"])(
        'r1 F1 refuses anonymous store JSX in forms and other files: %s',
        (body) => {
          const extra = inlineStore(`() => { ${body}; return null; }`);
          expect(rules(`${COMPLIANT} ${importG} const X = () => <G />;`, extra)).toContain(
            'unresolved',
          );
          expect(
            rules(COMPLIANT, { ...extra, 'app/Other.tsx': `${importG} const X = () => <G />;` }),
          ).toContain('unresolved');
        },
      );

      it.each([
        '({ f: () => slot.start() }).f',
        '(Math.random() ? () => slot.start() : () => null)',
        '(() => () => fencedSlot("z."))()',
      ])('r1 F2 refuses unresolvable bound targets outside and inside send: %s', (target) => {
        for (const form of [
          `${COMPLIANT} ${importG} G();`,
          `${importG} ${COMPLIANT.replace('send: () => submitThing(previous, form)', 'send: () => G()')}`,
        ])
          expect(rules(form, inlineStore(target))).toContain('unresolved');
      });

      it.each([
        '(() => fencedSlot("x.")).bind(null)',
        '(function () { return fencedSlot("x."); }).bind(null)',
        'Function.prototype.bind.call(() => fencedSlot("x."), null)',
        'Reflect.apply(Function.prototype.bind, () => fencedSlot("x."), [null])',
      ])('r1 F3 refuses anonymous factories inside send through adapters: %s', (bound) => {
        const form = `${importG} ${COMPLIANT.replace('send: () => submitThing(previous, form)', 'send: () => G()')}`;
        expect(
          rules(form, {
            'lib/inline-store.ts': `import { fencedSlot } from './unresolved-tenancy'; export const G = ${bound};`,
          }),
        ).toContain('store');
      });

      it.each(['for await (const x of [0]) {}', 'await using r = null;'])(
        'r1 F4 counts every callback-owned await form: %s',
        (suspend) => {
          expect(rules(reducer(`{ ${suspend} return ${boundary}; }`))).toContain('callback');
        },
      );

      it.each([
        '(Promise.reject(0), submitThroughSlot)({})',
        '(Promise.reject(previous), SB).submitThroughSlot({})',
        '(Promise.reject(previous), SB)["submitThroughSlot"]({})',
        'submitThroughSlot((Promise.reject(previous), {}))',
        '((Promise.reject(0), submitThroughSlot) as T)!({})',
        'submitThroughSlot(((Promise.reject(previous), {}) satisfies T)!)',
      ])(
        'r1 F5 refuses discarded operands at every returned boundary position: %s',
        (expression) => {
          for (const body of [expression, `{ return ${expression}; }`]) {
            const form = `import * as SB from '@/lib/fenced-submission'; ${reducer(body)}`;
            expect(rules(form)).toEqual(expect.arrayContaining(['callback', 'boundary']));
          }
        },
      );

      it('r1 F5 discarded options never protect eager store calls', () => {
        expect(rules(reducer('submitThroughSlot((0, { send: saveThing() }))'))).toContain('store');
      });

      it('r1 F5 checks effective options bound before the returned call', () => {
        const form = reducer('execute()').replace(
          'const send = useCallback(',
          'const execute = submitThroughSlot.bind(null, (Promise.reject(0), {})); const send = useCallback(',
        );
        expect(rules(form)).toEqual(expect.arrayContaining(['callback', 'boundary']));
      });

      it.each([
        '{ for (const x of [0]) {} using r = null; return submitThroughSlot({}); }',
        'submitThroughSlot({ send: async () => { for await (const x of [0]) {} await using r = null; } })',
        'submitThroughSlot({ send: () => (0, saveThing()) })',
      ])('r1 preserves synchronous loops/using and nested function ownership: %s', (body) => {
        expect(rules(reducer(body))).toEqual([]);
      });

      it.each(['await Promise.resolve(0)', 'Promise.reject(previous)', boundary, '0'])(
        'N1 refuses discarded comma operand %s in expression and block returns',
        (left) => {
          for (const expression of [`(${left}, ${boundary})`, `((${left}, ${boundary}) as T)!`]) {
            for (const body of [expression, `{ return ${expression}; }`]) {
              expect(rules(reducer(body))).toEqual(
                expect.arrayContaining(['callback', 'boundary']),
              );
            }
          }
        },
      );

      it.each([
        'submitThroughSlot({ ...(await options) })',
        'submitThroughSlot({ remember: await makeRemember() })',
        '(submitThroughSlot({ ...(await options) }) satisfies T)!',
      ])('N1 scans expression bodies for callback-owned awaits: %s', (expression) => {
        expect(rules(reducer(expression))).toContain('callback');
      });

      it.each([
        `(${boundary})`,
        `(${boundary} as T)`,
        `(${boundary} satisfies T)`,
        `(${boundary})!`,
        `((${boundary} as T) satisfies T)!`,
        'submitThroughSlot({ send: async () => await submitThing(previous, form) })',
        'submitThroughSlot({ async send() { return await submitThing(previous, form); } })',
        'submitThroughSlot({ send: async function () { return await submitThing(previous, form); } })',
      ])('N1 preserves wrappers and nested function ownership: %s', (expression) => {
        for (const body of [expression, `{ return ${expression}; }`])
          expect(rules(reducer(body))).toEqual([]);
      });

      it.each([
        '(() => null).bind(null)',
        '(function () { return null; }).bind(null)',
        '((() => null) as T).bind(null).bind(null)',
        '((() => null) satisfies T)!.bind(null)',
        '(0, () => null).bind(null)',
        'Function.prototype.bind.call(() => null, null)',
        'Reflect.apply(Function.prototype.bind, () => null, [null])',
      ])('N2 resolves inline bound JSX inside and outside forms: %s', (bound) => {
        expect(rules(`${COMPLIANT} const G = ${bound}; const X = () => <G />;`)).toEqual([]);
        expect(
          rules(COMPLIANT, {
            'lib/component.ts': `export const G = ${bound};`,
            'app/Other.tsx': "import { G } from '@/lib/component'; export const X = () => <G />;",
          }),
        ).toEqual([]);
      });

      it('N2 retains the defining module for form discovery and refuses anonymous store JSX', () => {
        const form = `
          import { G } from '@/lib/thing-store';
          import { useSlotActionState, submitThroughSlot } from '@/lib/fenced-submission';
          import { UnresolvedForm } from '@/app/UnresolvedQuarantine';
          useSlotActionState(() => submitThroughSlot({}), null);
          const X = () => <UnresolvedForm><G /></UnresolvedForm>;
        `;
        const sources = tree(form, {
          'lib/thing-store.ts': `${STORE} export const G = (() => null).bind(null);`,
        });
        expect(fencedForms(sources)).toEqual(['app/thing/ThingForm.tsx']);
        expect(fencedFormViolations(sources).map((violation) => violation.rule)).toEqual([
          'unresolved',
        ]);
      });

      it.each(['slot.start()', "fencedSlot('other.')"])(
        'N2 refuses invoking an anonymous bound store target outside the boundary: %s',
        (body) => {
          const form = `${COMPLIANT} import { run } from '@/lib/inline-store'; run();`;
          const extra = {
            'lib/inline-store.ts': `import { fencedSlot } from './unresolved-tenancy';
              const slot = fencedSlot('inline.'); export const run = (() => ${body}).bind(null);`,
          };
          expect(rules(form, extra)).toContain('store');
        },
      );

      it.each(['missing', 'Unknown', 'cycle'])(
        'N2 still refuses an unresolved bound target: %s',
        (target) => {
          const imports =
            "import { missing } from '@/lib/thing-store'; import { cycle } from '@/lib/cycle';";
          expect(
            rules(COMPLIANT, {
              'lib/cycle.ts': 'export { cycle } from "./cycle";',
              'app/Other.tsx': `${imports} const G = ${target}.bind(null); const X = () => <G />;`,
            }),
          ).toContain('unresolved');
        },
      );
    });

    it('refuses when resolution is exhausted, keeping where it stopped', () => {
      const cycle = {
        'lib/a.ts': "export { x } from './b'; export * from './thing-store';",
        'lib/b.ts': "export { x } from './a';",
      };
      expect(rules(`${COMPLIANT} import { missing } from '@/lib/thing-store'; missing();`)).toEqual(
        ['unresolved'],
      );
      expect(rules(`${COMPLIANT} import { x } from '@/lib/a'; x(); <x />;`, cycle)).toEqual([
        'unresolved',
        'unresolved',
      ]);
      // An unfollowable hook in a file that refers to a store is a form, held to every rule.
      const hidden = "import { x } from '@/lib/a'; export const Form = () => x(() => null, null);";
      expect(fencedForms(tree(hidden, cycle))).toEqual(['app/thing/ThingForm.tsx']);
      expect(rules(hidden, cycle)).toEqual(
        expect.arrayContaining(['unresolved', 'boundary', 'drawn']),
      );
      // A tag that may be the gate is refused in any file.
      expect(
        rules(COMPLIANT, {
          ...cycle,
          'app/other/X.tsx': "import { x as G } from '@/lib/b';\nexport const X = () => <G />;",
        }),
      ).toEqual(['unresolved']);
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
