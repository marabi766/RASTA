/**
 * @jest-environment node
 */

/**
 * FU-254 class guard: every release of a held request in the portal goes through `settleRelease`
 * and every page reads its outcome through `readReleaseFeedback` (rules R1–R5 in
 * `test/release-settlement-guard.ts`). The scan walks every shipped module under `app/`; nothing is
 * listed, so a seventh release action added later is held to the same rules.
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
const MODULES = sourceModules(['app']);
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
  it('scans the shipped modules of app/', () => {
    expect(MODULES.length).toBeGreaterThan(100);
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
  it('finds the six release actions behind settleRelease (a guard that sees nothing proves nothing)', () => {
    const calls = MODULES.map((name) => {
      const { text, file } = sourceOf(name);
      return { file, calls: settleReleaseCalls(text, file) };
    }).filter((entry) => entry.calls > 0);
    expect(calls.reduce((sum, entry) => sum + entry.calls, 0)).toBe(6);
    expect(calls.map((entry) => entry.file).sort()).toEqual([
      'app/assets/actions.ts',
      'app/drivers/actions.ts',
      'app/procurement/demands/demand-actions.ts',
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
import { releaseUnresolved } from '@/server/unresolved-request';
export async function releaseThing(form: FormData): Promise<void> {
  const session = await currentSession();
  return settleRelease({
    session,
    form,
    back: '/x',
    subject: { surface: 'project-creation' },
    release: (current, token) => releaseUnresolved(current, SCOPE, token),
  });
}
`;

describe('release settlement (the rules fire on what they forbid)', () => {
  it('accepts the shape every action has', () => {
    expect(rulesOf(GOOD_ACTION)).toEqual([]);
  });
  it('accepts a store release passed as the release callback by reference', () => {
    expect(
      rulesOf(`'use server';
import { settleRelease } from '@/server/release-feedback';
export async function releaseAsset(form: FormData) {
  return settleRelease({ session, form, back: '/a', subject, release: request.release });
}`),
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
  it('R1: the call outside the callback, even beside a settleRelease', () => {
    expect(
      rulesOf(`'use server';
import { settleRelease } from '@/server/release-feedback';
import { releaseUnresolved } from '@/server/unresolved-request';
export async function releaseThing(form: FormData) {
  await releaseUnresolved(session, SCOPE, form.get('release'));
  return settleRelease({ session, form, back: '/x', subject, release: () => 'RELEASED' });
}`),
    ).toContain('R1');
  });
  it.each([
    ["import { releaseUnresolved as drop } from '@/server/unresolved-request';"],
    ["import * as pending from '@/server/unresolved-request';"],
    [
      "import { releaseUnresolved } from '@/server/unresolved-request'; export { releaseUnresolved };",
    ],
    [
      "import { releaseUnresolved } from '@/server/unresolved-request'; const go = releaseUnresolved; go();",
    ],
    [
      "import { releaseUnresolved } from '@/server/unresolved-request'; const bag = { releaseUnresolved };",
    ],
    ["import * as pending from '@/server/unresolved-request'; pending['releaseUnresolved'](a);"],
    ["require('@/server/unresolved-request')['releaseUnresolved'](a);"],
  ])('R1: %s', (source) => {
    expect(rulesOf(source)).toContain('R1');
  });
  it('R1: the callback of a differently named function is not settleRelease', () => {
    expect(
      rulesOf(`import { releaseUnresolved } from '@/server/unresolved-request';
export const a = () => other({ release: (s, t) => releaseUnresolved(s, SCOPE, t) });`),
    ).toContain('R1');
  });
  it.each([
    ['const release = one(params.release);'],
    ["const release = params['release'];"],
    ["const release = url.searchParams.get('release');"],
    ['const { release } = params;'],
    ['const { release: word } = params;'],
    ["const { 'release': word } = params;"],
  ])('R2: %s', (source) => {
    expect(rulesOf(source, 'app/x/page.tsx')).toContain('R2');
  });
  it('R2: allowed only inside the one reader', () => {
    expect(
      rulesOf(
        'const outcome = readReleaseFeedback(session, subject, one(params.release), idle);',
        'app/x/page.tsx',
      ),
    ).toEqual([]);
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
