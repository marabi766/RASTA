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
