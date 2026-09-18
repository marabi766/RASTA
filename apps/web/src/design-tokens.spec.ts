import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The rules of docs/16 § 16.4, enforced instead of remembered.
 *
 * Three of them are stated as absolutes in the document — every value comes
 * from a token, dark mode is a token redefinition, no component branches on
 * theme — and all three are the kind of rule that survives the change that
 * introduces it and then erodes. A reviewer catches the first violation; the
 * fortieth arrives in a PR nobody reads closely. So they are tests.
 *
 * These assertions read the source as text. That is unusual, and it is the
 * right tool here: the properties under test are properties of the stylesheet
 * and of the component sources, not of anything a rendered component exposes.
 */

const SRC = join(__dirname);
const CSS = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8');

/** The `@theme { … }` block, where every token is declared. */
const themeBlock = (() => {
  const start = CSS.indexOf('@theme {');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = CSS.indexOf('{', start); i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(start, i + 1);
    }
  }
  throw new Error('The @theme block is not closed.');
})();

/** The `[data-theme='dark'] { … }` block — dark mode asked for by the document. */
const darkBlock = (() => {
  const start = CSS.indexOf("[data-theme='dark'] {");
  expect(start).toBeGreaterThan(-1);
  const end = CSS.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return CSS.slice(start, end);
})();

/** The `prefers-color-scheme: dark` block — dark mode asked for by the system. */
const systemDarkBlock = (() => {
  const start = CSS.indexOf(":root:not([data-theme='light']) {");
  expect(start).toBeGreaterThan(-1);
  const end = CSS.indexOf('\n  }', start);
  expect(end).toBeGreaterThan(start);
  return CSS.slice(start, end);
})();

/**
 * Just the `--token: value;` lines of a block, in order, with indentation and
 * comments dropped. Comparing these is how two blocks that must stay identical
 * are held to it without also demanding identical prose.
 */
function declarations(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('--'));
}

function collectTsxFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsxFiles(full, found);
    } else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.spec.tsx')) {
      found.push(full);
    }
  }
  return found;
}

describe('the token set of docs/16 § 16.4', () => {
  it.each([
    ['--color-primary-50', '--color-primary-950'],
    ['--color-neutral-50', '--color-neutral-950'],
  ])('declares the full ramp from %s to %s', (first, last) => {
    expect(themeBlock).toContain(first);
    expect(themeBlock).toContain(last);
    // 50, 100, 200 … 950 — eleven steps, and a gap in the middle is exactly
    // the kind of omission nobody notices until a component reaches for it.
    const family = first.replace('-50', '');
    for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
      expect(themeBlock).toContain(`${family}-${step}:`);
    }
  });

  it.each(['success', 'warning', 'danger', 'info', 'muted'])(
    'gives %s a solid colour, a surface tint and a text colour',
    (meaning) => {
      expect(themeBlock).toContain(`--color-${meaning}:`);
      expect(themeBlock).toContain(`--color-${meaning}-surface:`);
      expect(themeBlock).toContain(`--color-${meaning}-text:`);
    },
  );

  it.each(['base', 'raised', 'overlay', 'sunken'])('declares the %s surface', (level) => {
    expect(themeBlock).toContain(`--color-surface-${level}:`);
  });

  it.each(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'])(
    'declares the %s step of the type scale',
    (step) => {
      expect(themeBlock).toContain(`--text-${step}:`);
    },
  );

  it('follows the 1.25 ratio above the base size', () => {
    const read = (step: string) => {
      const match = new RegExp(`--text-${step}: ([\\d.]+)rem;`).exec(themeBlock);
      if (!match) throw new Error(`--text-${step} is missing`);
      return Number(match[1]);
    };
    const scale = ['base', 'lg', 'xl', '2xl', '3xl'].map(read);
    for (let i = 1; i < scale.length; i += 1) {
      // Rounded to three decimals in the stylesheet, so the check allows for
      // that and nothing more.
      expect(scale[i] / scale[i - 1]).toBeCloseTo(1.25, 2);
    }
  });

  it.each(['tight', 'normal', 'relaxed'])('declares the %s line height', (step) => {
    expect(themeBlock).toContain(`--leading-${step}:`);
  });

  // docs/16 asks for a 4px base. Tailwind v4 derives p-1 … p-16 from this one
  // value, so setting it is what makes --space-1 … --space-16 real.
  it('sets the spacing base to 4px', () => {
    expect(themeBlock).toMatch(/--spacing: 0\.25rem;/);
  });

  it.each(['sm', 'md', 'lg', 'xl', '2xl', 'full'])('declares the %s radius', (step) => {
    expect(themeBlock).toContain(`--radius-${step}:`);
  });

  it.each(['sm', 'md', 'lg'])('declares the %s shadow', (step) => {
    expect(themeBlock).toContain(`--shadow-${step}:`);
  });

  it('declares the motion tokens', () => {
    expect(themeBlock).toContain('--duration-fast:');
    expect(themeBlock).toContain('--duration-normal:');
    expect(themeBlock).toContain('--ease-out:');
  });
});

describe('dark mode', () => {
  /**
   * Every token whose value depends on the theme. A token that carries a
   * meaning — a surface, a border, text, a semantic colour — must be
   * redefined; the brand and neutral ramps are not, because a ramp is a
   * palette and the theme picks from it rather than changing it.
   */
  const THEME_DEPENDENT = [
    '--color-surface-base',
    '--color-surface-raised',
    '--color-surface-overlay',
    '--color-surface-sunken',
    '--color-content',
    '--color-content-muted',
    '--color-content-subtle',
    '--color-content-inverse',
    '--color-border',
    '--color-border-strong',
    '--color-focus',
    '--color-success',
    '--color-success-surface',
    '--color-success-text',
    '--color-warning',
    '--color-warning-surface',
    '--color-warning-text',
    '--color-danger',
    '--color-danger-surface',
    '--color-danger-text',
    '--color-info',
    '--color-info-surface',
    '--color-info-text',
    '--color-muted',
    '--color-muted-surface',
    '--color-muted-text',
    '--shadow-sm',
    '--shadow-md',
    '--shadow-lg',
  ];

  it.each(THEME_DEPENDENT)('redefines %s', (token) => {
    expect(themeBlock).toContain(`${token}:`);
    expect(darkBlock).toContain(`${token}:`);
  });

  // The values live in two places — a media query for the system preference
  // and an attribute selector for an explicit choice — because CSS cannot
  // share one declaration body between them. This is what stops the copies
  // from drifting, which is the only real cost of the duplication.
  it('applies the same values whether the system or the document asks for it', () => {
    expect(declarations(systemDarkBlock)).toEqual(declarations(darkBlock));
  });

  it('does not let an explicit light choice be overridden by the system', () => {
    expect(systemDarkBlock).toContain(":root:not([data-theme='light'])");
  });

  // The rule of docs/16 § 16.4 is that no component has a light/dark branch.
  // The cheapest way to keep it is to leave Tailwind's `dark:` variant
  // unconfigured, so reaching for it does not silently produce dead CSS.
  it('does not configure a dark: variant', () => {
    expect(CSS).not.toContain('@custom-variant dark');
  });

  it('is not reached for in any component', () => {
    const offenders = collectTsxFiles(SRC).filter((file) =>
      /\bdark:[a-z-]/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('no component hard-codes a value', () => {
  const files = collectTsxFiles(SRC);

  it('finds components to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each([
    ['a hex colour', /#[0-9a-fA-F]{3,8}\b/],
    ['an rgb() or hsl() literal', /\b(?:rgba?|hsla?)\(/],
    ['an arbitrary Tailwind value', /\b[a-z-]+-\[[^\]]+\]/],
    ['an inline style attribute', /\bstyle=\{\{/],
  ])('contains no %s', (_label, pattern) => {
    // The offending file is named in the failure rather than left to a bare
    // `false`, because "somewhere in src" is not a useful place to start.
    const offenders = files.filter((file) => pattern.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('layout is written with logical properties', () => {
  // In a right-to-left document `ml-*` and `text-left` do not flip. A
  // component that uses them looks correct in a Latin review and wrong in the
  // interface it was written for.
  const PHYSICAL = /\b(?:ml|mr|pl|pr)-(?:\d|px|auto)|\btext-(?:left|right)\b|\b(?:left|right)-\d/;

  it('uses no physical direction utility', () => {
    const offenders = collectTsxFiles(SRC).filter((file) =>
      PHYSICAL.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
