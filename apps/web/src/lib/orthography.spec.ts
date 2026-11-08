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

  it('refuses raw presentation forms', () => {
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

  it('rejects compatibility carriers with a separate hamza (carrier + marks sweep)', () => {
    let carriers = 0;
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const point = String.fromCodePoint(code);
      const expanded = point.normalize('NFKC');
      if (point === expanded || !/[اٱويىی]\p{M}*$/u.test(expanded.normalize('NFD'))) continue;
      carriers += 1;
      for (const marks of ['', '\u064e', '\u0651\u064e', '\u0640', '\u200c']) {
        for (const hamza of ['\u0654', '\u0655']) {
          expect([code, marks, hamza, nonStandardSpelling(point + marks + hamza)]).not.toContain(
            null,
          );
        }
      }
    }
    expect(carriers).toBeGreaterThan(150); // includes ligatures and supplementary letters
    for (const standard of ['أ', 'إ', 'ؤ', 'ئ']) {
      expect(nonStandardSpelling(standard)).toBeNull();
    }
    expect(nonStandardSpelling('\ufee9\u0654')).not.toBeNull(); // raw presentation heh
  });

  it('looks for the combining hamza before normalising (composition or stripping would hide it)', () => {
    const decomposed = 'تا\u064e\u0654مین';
    // NFC composes it away and stripping the marks deletes it; neither form is flagged by words alone…
    expect(nonStandardSpelling('تا\u0654مین'.normalize('NFC'))).toBeNull();
    // …so the raw text must be, with or without the intervening mark.
    expect(nonStandardSpelling(decomposed)).not.toBeNull();
    expect(nonStandardSpelling('تا\u0654مین')).not.toBeNull();
  });

  it.each(['أ', 'إ', 'آ', 'ؤ', 'ئ', '\ufe83', '\ufe85', '\ufe89', '\ufef7'])(
    'rejects an extra separate hamza on the composed carrier %s',
    (carrier) => {
      for (const hamza of ['\u0654', '\u0655']) {
        expect(nonStandardSpelling(carrier + '\u064e' + hamza)).not.toBeNull();
      }
    },
  );

  // F1: one row per executed review-table input (expanded grouped rows).
  it.each([
    ['high-hamza alef in a word', 'ت\u0675مین'],
    ['high hamza on alef', 'ا\u0674'],
    ['high hamza on yeh', 'ی\u0674'],
    ['high hamza on waw', 'و\u0674'],
    ['high-hamza waw', '\u0676'],
    ['high-hamza u', '\u0677'],
    ['high-hamza yeh', '\u0678'],
    ['presentation high-hamza u', '\ufbdd'],
    ['wavy hamza below', 'ا\u065f'],
    ['alef with wavy hamza above', '\u0672'],
    ['alef with wavy hamza below', '\u0673'],
    ['extended yeh hamza', 'ر\u08a8یس'],
    ['enclosing mark before hamza', 'ا\u20dd\u0654'],
    ['spacing mark before hamza', 'ا\u0903\u0654'],
    ['alef wasla inside a word', 'ت\u0671مین'],
    ['extra hamza control', 'أ\u064e\u0654'],
    ['mathematical alef control', '\u{1ee00}\u0654'],
  ])('refuses review F1: %s', (_, text) => {
    expect(nonStandardSpelling(text)).not.toBeNull();
  });

  it.each(['\u0301', '\u0903', '\u20dd'])('refuses adjacent Mn/Mc/Me %s', (mark) => {
    for (const text of ['ب' + mark, mark + 'ب', 'ب\u064e\u200d' + mark, mark + '\u200d\u064eب']) {
      expect(nonStandardSpelling(text)).not.toBeNull();
    }
    expect(nonStandardSpelling('Latin ' + mark)).toBeNull();
  });

  it.each([
    '\u0600',
    '\u0750',
    '\u08ff',
    '\ufb50',
    '\ufdff',
    '\ufe70',
    '\ufeff',
    '\u{1eeff}',
    '\ufe83',
    '\ufe85',
    '\ufe89',
    '\ufef7',
    '\ufee9',
  ])('refuses unknown raw Arabic-block code points even if NFKC folds them: %s', (point) =>
    expect(nonStandardSpelling(point)).not.toBeNull(),
  );

  it.each([
    ['Arabic', '\u0675'],
    ['Supplement', '\u0750'],
    ['Extended-A', '\u08a8'],
    ['Extended-B right hamza', '\u0881'],
    ['Extended-B left hamza', '\u0882'],
    ['Extended-B tatweel hamza', '\u0883'],
    ['Extended-B alef', '\u0870'],
    ['Extended-B format control', '\u0890'],
    ['Extended-C', '\u{10ec2}'],
    ['Presentation Forms-A', '\ufbdd'],
    ['Presentation Forms-B', '\ufe83'],
    ['Mathematical', '\u{1ee00}'],
    ['Rumi numeral', '\u{10e60}'],
  ])('refuses Arabic-script points inside a word: %s', (_, point) => {
    expect(nonStandardSpelling('ت' + point + 'مین')).not.toBeNull();
  });

  it('sweeps the Arabic script properties independently of block ranges', () => {
    const permitted = new Set([
      ...'ءآأؤإئابتثجحخدذرزسشصضطظعغفقكلمنهويىپچژکگی',
      ...'٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹،؛؟٪٫٬۔',
      ...'\u061c\u0640\u064b\u064c\u064d\u064e\u064f\u0650\u0651\u0652',
    ]);
    const missed: string[] = [];
    let refused = 0;
    for (let code = 0; code <= 0x10ffff; code += 1) {
      const point = String.fromCodePoint(code);
      if (!/[\p{Script=Arabic}\p{Script_Extensions=Arabic}]/u.test(point)) continue;
      if (permitted.has(point)) continue;
      refused += 1;
      for (const text of [point, 'ب' + point, 'ت' + point + 'مین']) {
        if (nonStandardSpelling(text) === null) missed.push(`U+${code.toString(16)}: ${text}`);
      }
    }
    expect(refused).toBeGreaterThan(1000);
    expect(missed).toEqual([]);
  });

  it.each(['\u0313', '\u0903', '\u20dd', '\u0898', '\u{10efa}'])(
    'refuses unknown marks carried across tatweel: %s',
    (mark) => {
      for (const text of ['ی\u0640' + mark, mark + '\u0640ی', 'ی\u200d\u0640' + mark]) {
        expect(nonStandardSpelling(text)).not.toBeNull();
      }
    },
  );

  it.each(['\u06c0', '\u0629', '\u0670'])('keeps the PM-decided ezafe exclusions: %s', (point) => {
    expect(nonStandardSpelling('ب' + point)).not.toBeNull();
  });

  it('allows only the explicit Persian repertoire and usual diacritics', () => {
    expect(nonStandardSpelling('ءآأؤإئابتثجحخدذرزسشصضطظعغفقكلمنهويىپچژکگی')).toBeNull();
    expect(nonStandardSpelling('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹،؛؟٪٫٬۔\u061c\u0640')).toBeNull();
    expect(nonStandardSpelling('ب\u064b\u064c\u064d\u064e\u064f\u0650\u0651\u0652')).toBeNull();
    for (const text of ['\u0654', 'ب\u0654', 'ه\u0655', 'ه\u0654\u0654', 'ه\u200c\u0654']) {
      expect(nonStandardSpelling(text)).not.toBeNull();
    }
  });

  it('allows the ezafe: heh + combining hamza', () => {
    expect(nonStandardSpelling('شماره\u0654 دارایی')).toBeNull();
    expect(nonStandardSpelling('شماره\u064e\u0654')).not.toBeNull();
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

  it.each([
    ['apps/web/src/x.ts', "export const t = 'ت\\u0675مین';"],
    ['apps/web/src/x.tsx', 'export const X = () => <p>ت&#x675;مین</p>;'],
    ['apps/web/src/x.json', '{"t":"ت\\u0675مین"}'],
    ['apps/web/src/x.css', 'a::after { content: "ت\\675 مین"; }'],
    ['packages/copy/src/index.ts', "export const t = 'ت\u0675مین';"],
  ])('refuses the same hamza-encoding class through %s', (path, source) => {
    expect(workspace({ [path]: source }).offenders).toContainEqual(expect.stringContaining(path));
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
    ['trailing comma', '{"a": 1,}'],
    ['single quotes', "{'a': 1}"],
    ['comment', '{/* copy */"a": 1}'],
    ['NaN', '{"a": NaN}'],
    ['undefined', '{"a": undefined}'],
    ['empty document', ''],
    ['extra root', '{} {}'],
    ['invalid escape', '{"a": "\\x61"}'],
    ['unescaped control', '{"a": "a\nb"}'],
  ])('refuses strict JSON: %s', (_, source) => {
    const scan = workspace({ 'apps/web/src/copy.json': source });
    expect(scan.failures).toContainEqual(expect.stringContaining('copy.json:1: parse error: JSON'));
  });

  it('validates dependency manifests before discovery can skip them', () => {
    const scan = workspace({ 'packages/unused/package.json': '{"name": "@x/unused",}' });
    expect(scan.failures).toContainEqual(
      expect.stringContaining('packages/unused/package.json:1: parse error: JSON'),
    );
  });

  it('accepts JSONC build configuration and still checks its strings', () => {
    expect(
      workspace({ 'apps/web/tsconfig.json': '{/* config */"include": ["src",],}' }).failures,
    ).toEqual([]);
    rmSync(root, { recursive: true, force: true });
    const scan = workspace({ 'apps/web/tsconfig.guard.json': `{/* config */"label": "${word}",}` });
    expect(scan.failures).toEqual([]);
    expect(scan.offenders).not.toEqual([]);
  });

  it.each([
    ['apps/web/turbo.json', '{/* config */"tasks": {},}'],
    ['packages/copy/tsconfig.json', '{/* config */"include": [],}'],
  ])('accepts the declared JSONC grammar at %s', (path, source) => {
    expect(workspace({ [path]: source }).failures).toEqual([]);
  });

  it.each(['apps/web/src/tsconfig.json', 'apps/web/src/turbo.json'])(
    'refuses JSONC in ordinary source inputs: %s',
    (path) => {
      expect(workspace({ [path]: '{/* not a root config */"a": 1,}' }).failures).not.toEqual([]);
    },
  );

  it.each(['apps/web/src/tsconfig.json', 'apps/web/turbo.json', 'apps/web/tsconfig.json'])(
    'refuses invalid JSON/JSONC at %s',
    (path) => {
      expect(workspace({ [path]: '{"a": NaN}' }).failures).not.toEqual([]);
    },
  );

  it.each([
    ['unclosed block', 'a { color: red;'],
    ['unclosed comment', '/* unfinished'],
    ['unclosed string', 'a { content: "unfinished; }'],
    ['missing colon', 'a { color red; }'],
    ['unclosed bracket', 'a { color: var(--x; }'],
    ['extra closing brace', 'a {} }'],
  ])('refuses CSS parse errors: %s', (_, source) => {
    expect(workspace({ 'apps/web/src/copy.css': source }).failures).toContainEqual(
      expect.stringContaining('copy.css:1: parse error: CSS'),
    );
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
