/**
 * @jest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { HAMZA_LESS_WORDS, nonStandardSpelling } from '@/test/orthography';
import { scanOrthography } from '@/test/orthography-scan';

/**
 * The product's Persian is in standard orthography, hamza included (owner
 * decision 2026-10-24: تأمین، تأیید، مسئول). This replaces the earlier
 * product-side "no hamza" rule; that rule belongs to PM reports and Telegram.
 * What is read, decoded and folded, and what is out of reach, is written at
 * the top of `test/orthography-scan.ts`. Wrong spellings in this file are
 * built from code points or from the dictionary, so it holds none as text.
 */
const REPO = join(__dirname, '..', '..', '..', '..');
const APP = join(__dirname, '..', '..');

const at = (text: string, index: number, insert: string) =>
  text.slice(0, index) + insert + text.slice(index);
const arabicLetters = (text: string) => text.replace(/ی/g, 'ي').replace(/ک/g, 'ك');
/** The standard spelling of each dictionary word, in the same order. */
const STANDARD = [
  'تأمین', 'تأیید', 'تأثیر', 'تأخیر', 'تأکید', 'تأسیس', 'تألیف', 'مأخذ', 'مسئله', 'مسائل',
  'ارائه', 'مؤلف', 'مأمور', 'متأسف', 'هیئت', 'رئیس', 'مسئول', 'مسئول', 'جزئیات',
]; // prettier-ignore

describe('the shipped sources', () => {
  it('hold no non-standard spelling, and every file was analysed completely', () => {
    const scan = scanOrthography(REPO, APP);
    expect(scan.failures).toEqual([]);
    expect(scan.offenders).toEqual([]);
    // Not a count: one file of each kind the build ships, from the app and a package.
    for (const file of [
      'apps/web/src/app/layout.tsx',
      'apps/web/src/app/globals.css',
      'apps/web/next.config.mjs',
      'apps/web/package.json',
      'packages/contracts/src/index.ts',
    ]) {
      expect(scan.checked).toContain(file);
    }
  });
});

describe('the spelling matcher', () => {
  it.each(HAMZA_LESS_WORDS.map((word, index) => [word, STANDARD[index] as string]))(
    '%s: caught bare, in Arabic letters, split by an invisible character, compounded; %s passes',
    (word, standard) => {
      expect(nonStandardSpelling(standard)).toBeNull();
      expect(nonStandardSpelling(`${standard}\u200cها و ${standard}ی`)).toBeNull();
      expect(nonStandardSpelling(word)).not.toBeNull();
      expect(nonStandardSpelling(arabicLetters(word))).not.toBeNull();
      for (let index = 1; index < word.length; index += 1) {
        for (const invisible of ['\u200c', '\u0640', '\u064e', '\u200d']) {
          expect([
            word,
            index,
            invisible,
            nonStandardSpelling(at(word, index, invisible)),
          ]).not.toContainEqual(null);
        }
      }
      for (const compound of [
        `${word}\u200cنشده`,
        `${word}نشده`,
        `بی\u200c${word}`,
        `بی${word}`,
        `«${word}»`,
      ]) {
        expect([compound, nonStandardSpelling(compound)]).not.toContainEqual(null);
      }
      // Inside another word it is not this word.
      expect(nonStandardSpelling(`و${word}`)).toBeNull();
    },
  );

  it('does not flag valid words that contain a dictionary word', () => {
    for (const valid of ['ویتامین', 'الهیات', 'بدیهیات', 'ماهیات', 'ویتامین\u200cها']) {
      expect([valid, nonStandardSpelling(valid)]).toEqual([valid, null]);
    }
  });

  it('folds presentation forms', () => {
    expect(nonStandardSpelling('\ufe97\ufe8e\ufee3\ufbff\ufee6')).not.toBeNull();
  });

  it.each(['ا', 'و', 'ی', 'ي', 'ى', '\ufe8d'])(
    'rejects a combining hamza on %s, also after other marks',
    (carrier) => {
      for (const marks of ['', '\u064e', '\u0651\u064e', '\u0640', '\u200c']) {
        for (const hamza of ['\u0654', '\u0655']) {
          expect(nonStandardSpelling(`${carrier}${marks}${hamza}`)).not.toBeNull();
        }
      }
    },
  );

  it('looks for the combining hamza before normalising (composition or stripping would hide it)', () => {
    const decomposed = 'تا\u064e\u0654مین';
    // NFC composes it away and stripping the marks deletes it; neither form is flagged by words alone…
    expect(nonStandardSpelling('تا\u0654مین'.normalize('NFC'))).toBeNull();
    // …so the raw text must be, with or without the intervening mark.
    expect(nonStandardSpelling(decomposed)).not.toBeNull();
    expect(nonStandardSpelling('تا\u0654مین')).not.toBeNull();
  });

  it('allows the ezafe: heh + combining hamza', () => {
    expect(nonStandardSpelling('شماره\u0654 دارایی')).toBeNull();
    expect(nonStandardSpelling('شماره\u064e\u0654')).toBeNull();
  });
});

describe('the scan, on a fixture workspace', () => {
  const word = HAMZA_LESS_WORDS[0];
  const [first, rest] = [word.slice(0, 2), word.slice(2)];
  const escaped = [...word]
    .map((c) => `\\u${c.codePointAt(0)?.toString(16).padStart(4, '0')}`)
    .join('');
  const entity = [...word].map((c) => `&#${c.codePointAt(0)};`).join('');
  const cssEscaped = [...word].map((c) => `\\${c.codePointAt(0)?.toString(16)} `).join('');
  let root: string;

  function workspace(files: Record<string, string>) {
    root = mkdtempSync(join(tmpdir(), 'orthography-'));
    const base: Record<string, string> = {
      'apps/web/package.json': JSON.stringify({ dependencies: { '@x/copy': 'workspace:*' } }),
      'packages/copy/package.json': JSON.stringify({ name: '@x/copy' }),
      'apps/web/src/app/page.tsx': 'export default function Page() { return null; }\n',
    };
    for (const [path, text] of Object.entries({ ...base, ...files })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return scanOrthography(root, join(root, 'apps/web'));
  }
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    [
      'a route under a directory named test',
      'apps/web/src/app/test/page.tsx',
      `export const t = '${word}';`,
    ],
    ['a .jsx module', 'apps/web/src/app/x.jsx', `export const t = '${word}';`],
    ['a .mjs module', 'apps/web/src/x.mjs', `export const t = '${word}';`],
    ['a .cjs module', 'apps/web/x.cjs', `module.exports = '${word}';`],
    ['a .js module', 'apps/web/src/x.js', `export const t = '${word}';`],
    ['JSON', 'apps/web/src/copy.json', JSON.stringify({ t: escaped }).replace(/\\\\/g, '\\')],
    ['CSS, escaped', 'apps/web/src/app/x.css', `a::after { content: "${cssEscaped}"; }`],
    ['a JS escape', 'apps/web/src/x.ts', `export const t = '${escaped}';`],
    [
      'a concatenation',
      'apps/web/src/x.ts',
      `export const t = ('${first}' + ('' + '${rest}')) as string;`,
    ],
    ['a literal-only template', 'apps/web/src/x.ts', `export const t = \`${first}\${'${rest}'}\`;`],
    ['a JSX entity', 'apps/web/src/x.tsx', `export const X = () => <p>${entity}</p>;`],
    [
      'a JSX attribute entity',
      'apps/web/src/x.tsx',
      `export const X = () => <p title="${entity}" />;`,
    ],
    [
      'JSX text and a literal child',
      'apps/web/src/x.tsx',
      `export const X = () => <p>${first}{'${rest}'}</p>;`,
    ],
    ['a workspace package', 'packages/copy/src/index.ts', `export const t = '${word}';`],
  ])('finds the word in %s', (_, path, text) => {
    const { offenders } = workspace({ [path]: text });
    expect(offenders).not.toEqual([]);
    for (const offender of offenders) expect(offender).toContain(path);
  });

  it('finds the word in a spec file that a shipped module imports, and skips an unimported one', () => {
    const scan = workspace({
      'apps/web/src/copy.spec.ts': `export const t = '${word}';`,
      'apps/web/src/other.spec.ts': `export const t = '${word}';`,
      'apps/web/src/app/x.ts': "import { t } from '@/copy.spec';\nexport default t;",
    });
    expect(scan.offenders).not.toEqual([]);
    for (const offender of scan.offenders)
      expect(offender).toContain('apps/web/src/copy.spec.ts:1');
  });

  it('decodes per context: an entity in a JS string and a JS escape in JSX text are not rendered', () => {
    expect(workspace({ 'apps/web/src/x.tsx': `export const t = '${entity}';` }).offenders).toEqual(
      [],
    );
    rmSync(root, { recursive: true, force: true });
    expect(
      workspace({ 'apps/web/src/x.tsx': `export const X = () => <p>${escaped}</p>;` }).offenders,
    ).toEqual([]);
    rmSync(root, { recursive: true, force: true });
    expect(
      workspace({ 'apps/web/src/x.ts': `export const t = '${cssEscaped}';` }).offenders,
    ).toEqual([]);
  });

  it.each([
    ['a parse error', 'apps/web/src/x.ts', 'export const = ;', 'apps/web/src/x.ts:1: parse error'],
    [
      'an unresolved import',
      'apps/web/src/x.ts',
      "\nimport './missing';",
      "apps/web/src/x.ts:2: cannot resolve './missing'",
    ],
    [
      'a computed import',
      'apps/web/src/x.ts',
      'const m = "a";\nvoid import(m);',
      'apps/web/src/x.ts:2: computed import',
    ],
    [
      'a workspace sub-path',
      'apps/web/src/x.ts',
      "import '@x/copy/deep';",
      "apps/web/src/x.ts:1: workspace sub-path import '@x/copy/deep'",
    ],
    [
      'an unquoted CSS import',
      'apps/web/src/a.css',
      '@import url(./missing.css);',
      "apps/web/src/a.css:1: cannot resolve './missing.css'",
    ],
    [
      'an app alias in a package',
      'packages/copy/src/x.ts',
      "import '@/x';",
      "packages/copy/src/x.ts:1: '@/' outside the web app",
    ],
    ['unparsable JSON', 'apps/web/src/x.json', '{ "a": ', 'apps/web/src/x.json:1: parse error'],
  ])('fails closed on %s', (_, path, text, failure) => {
    expect(workspace({ [path]: text }).failures).toContainEqual(expect.stringContaining(failure));
  });
});
