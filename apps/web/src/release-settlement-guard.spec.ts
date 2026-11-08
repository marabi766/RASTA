/**
 * @jest-environment node
 */

/**
 * FU-254 class guard: every release of a held request in the portal goes through `settleRelease`
 * and every page reads its outcome through `readReleaseFeedback` (rules R1–R5 in
 * `test/release-settlement-guard.ts`). The boundary itself is in the code (`ReleaseScope`, `pageParams`
 * withholding the `release` key); this scan is the backstop and walks every shipped module of `app/`,
 * `lib/`, `server/` and `ui/` — wrappers outside `app/` included. Nothing is listed, so a seventh
 * release action added later is held to the same rules.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sourceModules } from './test/module-discovery';
import {
  releaseSettlementViolations,
  settleReleaseCalls,
  type Violation,
} from './test/release-settlement-guard';

const SRC = __dirname;
const MODULES = sourceModules(['app', 'lib', 'server', 'ui']).concat([
  'instrumentation',
  'middleware',
]);
const sourceOf = (name: string) => {
  const ext = ['.tsx', '.ts'].find((e) => {
    try {
      readFileSync(join(SRC, name + e));
      return true;
    } catch {
      return false;
    }
  });
  if (ext === undefined) throw new Error(`no source for ${name}`);
  return { text: readFileSync(join(SRC, name + ext), 'utf8'), file: name + ext };
};

describe('release settlement (the real tree)', () => {
  it('scans the shipped modules of app/, lib/, server/ and ui/', () => {
    expect(MODULES.length).toBeGreaterThan(200);
    expect(MODULES).toEqual(
      expect.arrayContaining(['server/create-request', 'lib/release-messages']),
    );
  });
  it('has no violation in any module', () => {
    const found = MODULES.flatMap((name) => {
      const { text, file } = sourceOf(name);
      return releaseSettlementViolations(text, file).map(
        (v) => `${file}:${v.line} ${v.rule} ${v.message}`,
      );
    });
    expect(found).toEqual([]);
  });
  it('finds the seven release actions behind settleRelease (a guard that sees nothing proves nothing)', () => {
    const calls = MODULES.map((name) => {
      const { text, file } = sourceOf(name);
      return { file, calls: settleReleaseCalls(text, file) };
    }).filter((entry) => entry.calls > 0);
    expect(calls.reduce((sum, entry) => sum + entry.calls, 0)).toBe(7);
    expect(calls.map((entry) => entry.file).sort()).toEqual([
      'app/assets/actions.ts',
      'app/drivers/actions.ts',
      'app/procurement/demands/demand-actions.ts',
      'app/projects/[id]/need-add-actions.ts',
      'app/projects/actions.ts',
      'app/suppliers/supplier-actions.ts',
      'app/wallet/actions.ts',
    ]);
  });
});

const rulesOf = (source: string, file = 'app/x/actions.ts'): Violation['rule'][] =>
  releaseSettlementViolations(source, file).map((v) => v.rule);

const GOOD_ACTION = `'use server';
import { settleRelease } from '@/server/release-feedback';
import { PROJECT_CREATE_RELEASE } from '@/server/project-create-replay';
export async function releaseThing(form: FormData): Promise<void> {
  const session = await currentSession();
  return settleRelease({
    session,
    form,
    back: '/x',
    subject: { surface: 'project-creation' },
    scope: PROJECT_CREATE_RELEASE,
  });
}
`;

describe('release settlement (the rules fire on what they forbid)', () => {
  it('accepts the shape every action has', () => {
    expect(rulesOf(GOOD_ACTION)).toEqual([]);
  });
  it('accepts the store names a module may use, and type-only imports of the rest', () => {
    expect(
      rulesOf(`import { readUnresolved, releaseToken, type UnresolvedRead } from '@/server/unresolved-request';
import type { ReleaseOutcome } from '@/server/unresolved-request';`),
    ).toEqual([]);
  });
  it('R1: a direct call from an action', () => {
    expect(
      rulesOf(`'use server';
import { releaseUnresolved } from '@/server/unresolved-request';
export async function releaseThing(form: FormData) {
  const outcome = await releaseUnresolved(session, SCOPE, form.get('release'));
  redirect(outcome === 'RELEASED' ? '/x' : '/x?y=1');
}`),
    ).toContain('R1');
  });
  it.each([
    ["import { releaseUnresolved as drop } from '@/server/unresolved-request';"],
    ["import * as pending from '@/server/unresolved-request';"],
    ["import pending from '@/server/unresolved-request';"],
    ["import '@/server/unresolved-request';"],
    ["import { somethingNew } from '@/server/unresolved-request';"],
    ["export { releaseUnresolved } from '@/server/unresolved-request';"],
    ["export * from '@/server/unresolved-request';"],
    [
      "import { releaseUnresolved } from '@/server/unresolved-request'; const go = releaseUnresolved; go();",
    ],
    ["import * as pending from '@/server/unresolved-request'; pending['releaseUnresolved'](a);"],
    ["require('@/server/unresolved-request')['releaseUnresolved'](a);"],
    ["import pending = require('@/server/unresolved-request');"],
    ['const settleRelease = (o) => o; settleRelease({ scope });'],
    ["import { settleRelease } from './my-release'; settleRelease({ scope });"],
    ["import { ReleaseScope } from '@/server/release-scope'; export const s = ReleaseScope.of(x);"],
    ["import * as p from '@/server/page-context'; p.releaseTokenOf(params);"],
    ["import { releaseTokenOf } from '@/server/page-context'; releaseTokenOf(params);"],
  ])('R1: %s', (source) => {
    expect(rulesOf(source)).toContain('R1');
  });

  // The six bypass shapes of review 1 (F1). On 4ea23625 every one of them returned [] (the guard was green).
  // Here each is refused (R1/R2), and the first four and the sixth are also unreachable by construction:
  // the module that holds the primitive hands no scope to `app/`, and `pageParams` carries no `release` key.
  describe('review 1 bypass shapes', () => {
    it.each([
      [
        'dynamic import() with a computed member',
        "'use server'; export const dismissHold = async (f) => (await import('@/server/unresolved-request'))['release' + 'Unresolved'](s, SCOPE, f.get(FIELD));",
        'app/x/actions.ts',
      ],
      ['export * re-export', "export * from '@/server/unresolved-request';", 'app/x/actions.ts'],
      [
        'export * re-export from a server wrapper',
        "export * from './unresolved-request';",
        'server/wrapper.ts',
      ],
      [
        'the re-exporting module itself (a namespace import of it is then clean: there is nothing to call)',
        "export { releaseUnresolved } from '@/server/unresolved-request';",
        'app/x/helpers.ts',
      ],
      [
        'the re-exporting module itself, as export *',
        "export * from '@/server/unresolved-request';",
        'server/helpers.ts',
      ],
      [
        'import() in a wrapper outside app/ (non-literal path)',
        'export const load = (name) => import(name);',
        'server/wrapper.ts',
      ],
      [
        'import() of the store in a wrapper outside app/',
        "export const load = () => import('./unresolved-request');",
        'server/wrapper.ts',
      ],
      [
        'wrapper outside app/ importing the primitive under another name',
        "import { releaseUnresolved as drop } from './unresolved-request'; export const wrap = (s, t) => drop(s, SCOPE, t);",
        'server/wrapper.ts',
      ],
      [
        'wrapper outside app/ with a computed member on the store namespace',
        "import * as u from './unresolved-request'; export const wrap = (s, t) => u['release' + 'Unresolved'](s, SCOPE, t);",
        'server/wrapper.ts',
      ],
    ])('R1 refuses: %s', (_name, source, file) => {
      expect(rulesOf(source, file)).toContain('R1');
    });
    it.each([
      [
        'a query read keyed by RELEASE_FIELD',
        "import { RELEASE_FIELD } from '@/lib/release-messages'; export const v = (p, f) => [p[RELEASE_FIELD], f.get(RELEASE_FIELD), new URLSearchParams(q).get(RELEASE_FIELD)];",
      ],
      [
        'a query read keyed by the query constant',
        "import { RELEASE_QUERY } from '@/lib/release-messages'; export const v = (p) => p[RELEASE_QUERY];",
      ],
    ])('R2 refuses: %s', (_name, source) => {
      expect(rulesOf(source, 'app/x/page.tsx')).toContain('R2');
    });
    it('a computed `.release` on a wrapper has nothing to call: the wrapper cannot name the store', () => {
      expect(
        rulesOf(
          "import * as c from '@/server/create-request'; export const forgetAsset = async (f) => c.assetRegistrationRequest['rel' + 'ease'](s, f.get(RELEASE_FIELD));",
        ),
      ).toContain('R2');
    });
  });

  it('a consumer of a re-exporter has nothing to call, and a computed key reads a query without the key', () => {
    // Made irrelevant by construction rather than refused: see `release-feedback.spec.ts` (the params a page
    // gets carry no `release` key) and the re-exporting module cases above.
    expect(
      rulesOf(
        "import * as h from './helpers'; export const f = async (x) => h['release' + 'Unresolved'](s, SCOPE, x);",
      ),
    ).toEqual([]);
    expect(
      rulesOf("const K = 'rel' + 'ease'; export const v = (p) => p[K];", 'app/x/page.tsx'),
    ).toEqual([]);
  });
  it.each([
    // The name without an import: destructured from something loaded some other way, or a member of it.
    [
      'const { releaseUnresolved } = shared; export const w = (s, t) => releaseUnresolved(s, SCOPE, t);',
    ],
    ["export const w = (s, t) => shared['releaseUnresolved'](s, SCOPE, t);"],
    ['export const w = (s, t) => shared.releaseUnresolved(s, SCOPE, t);'],
  ])('R1: the primitive named without an import: %s', (source) => {
    expect(rulesOf(source, 'server/wrapper.ts')).toContain('R1');
  });
  it.each([
    ["export { readUnresolved } from '@/server/unresolved-request';", 'server/wrapper.ts'],
    ["export { ReleaseScope } from './release-scope';", 'lib/wrapper.ts'],
    [
      "import * as made from '@/server/release-scope'; export const s = made['Release' + 'Scope'];",
      'app/x/actions.ts',
    ],
    ["import '@/server/release-scope';", 'app/x/actions.ts'],
  ])('R1: hiding the store or the scope behind a re-export or namespace: %s', (source, file) => {
    expect(rulesOf(source, file)).toContain('R1');
  });
  it('R2: the withheld token reached by a member, not an import', () => {
    expect(
      rulesOf('export const t = (deps, params) => deps.releaseTokenOf(params);', 'app/x/page.tsx'),
    ).toContain('R2');
  });
  it('F2: the release field and query names are declared once, in lib/release-messages', () => {
    const declared = MODULES.flatMap((name) => {
      const { text } = sourceOf(name);
      return [...text.matchAll(/\bconst\s+(RELEASE_FIELD|RELEASE_QUERY)\b/g)].map(
        (match) => `${name}:${match[1]}`,
      );
    });
    expect(declared.sort()).toEqual([
      'lib/release-messages:RELEASE_FIELD',
      'lib/release-messages:RELEASE_QUERY',
    ]);
  });
  it('R1: app/ may not use import() or export * at all', () => {
    expect(rulesOf("export const a = () => import('./local');", 'app/x/page.tsx')).toContain('R1');
    expect(rulesOf("export * from './local';", 'app/x/page.tsx')).toContain('R1');
    expect(rulesOf("export const a = () => import('./local');", 'instrumentation.ts')).toEqual([]);
  });
  it('R1: ReleaseScope and release-scope stay in server/', () => {
    expect(
      rulesOf(
        "import { ReleaseScope } from './release-scope'; export const s = ReleaseScope.of(x);",
        'server/top-up-request.ts',
      ),
    ).toEqual([]);
    expect(rulesOf('export const s = ({ scope: x } as ReleaseScope);', 'lib/forged.ts')).toContain(
      'R1',
    );
  });
  it('R2: the form field is spelled in app/ only as the hidden input name', () => {
    expect(
      rulesOf(
        'export const f = () => <input type="hidden" name={RELEASE_FIELD} value={t} />;',
        'app/x/Notice.tsx',
      ),
    ).toEqual([]);
    expect(rulesOf('const t = form.get(RELEASE_FIELD);', 'app/x/actions.ts')).toContain('R2');
  });
  it.each([
    ['const release = one(params.release);'],
    ["const release = params['release'];"],
    ["const release = url.searchParams.get('release');"],
    ['const { release } = params;'],
    ['const { release: word } = params;'],
    ["const { 'release': word } = params;"],
    ['const outcome = readReleaseFeedback(session, subject, one(params.release), idle);'],
  ])('R2: %s', (source) => {
    expect(rulesOf(source, 'app/x/page.tsx')).toContain('R2');
  });
  it('R3: the retired parameter constant', () => {
    expect(rulesOf('const x = RELEASE_PARAM;', 'app/x/page.tsx')).toContain('R3');
    expect(rulesOf("import { RELEASE_PARAM } from './form-state';", 'app/x/page.tsx')).toContain(
      'R3',
    );
  });
  it.each([
    ['redirect(`${back}?release=${outcome}`);'],
    ["redirect('/projects?release=STALE');"],
    ["redirect(back + 'x&release=y');"],
  ])('R4: %s', (source) => {
    expect(rulesOf(source)).toContain('R4');
  });
  it('R5: a release/reconcile server action that never calls settleRelease', () => {
    expect(
      rulesOf(`'use server';
export async function reconcileThing(form: FormData): Promise<void> {
  redirect('/x');
}`),
    ).toContain('R5');
    expect(
      rulesOf(`'use server';
export const releaseThing = async (form: FormData) => { redirect('/x'); };`),
    ).toContain('R5');
  });
  it('R5: not for a module that is not a server-action module, nor for other names', () => {
    expect(rulesOf('export async function releaseThing() {}', 'app/x/helper.ts')).toEqual([]);
    expect(rulesOf(`'use server';\nexport async function submitThing() {}`)).toEqual([]);
  });
});
