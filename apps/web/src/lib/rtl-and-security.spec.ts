import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Invariants that hold across the whole source tree.
 *
 * Component tests check behaviour one screen at a time; these check properties
 * that are only true if they are true everywhere. A single `margin-left` in an
 * RTL application is a broken component, and the file it lives in is exactly
 * the one nobody thought to write a test for.
 *
 * ESLint enforces the same direction rules while you type (`eslint.config.mjs`).
 * The duplication is deliberate: a rule can be disabled inline with a comment,
 * and a scan of the emitted source cannot.
 */

const SRC = path.join(__dirname, '..');

function sourceFiles(directory: string = SRC): string[] {
  const collected: string[] = [];

  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      collected.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx|css)$/.test(entry) && !/\.spec\.(ts|tsx)$/.test(entry)) collected.push(full);
  }

  return collected;
}

const FILES = sourceFiles().map((file) => ({
  path: path.relative(SRC, file).replace(/\\/g, '/'),
  source: readFileSync(file, 'utf8'),
}));

/** Strips comments so prose about `margin-left` does not fail the scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

describe('the document declares Persian and RTL', () => {
  const layout = readFileSync(path.join(SRC, 'app', 'layout.tsx'), 'utf8');

  it('sets lang="fa" and dir="rtl" on <html>', () => {
    expect(layout).toMatch(/<html\s+lang="fa"\s+dir="rtl"/);
  });

  it('does not lock zoom, which would fail WCAG', () => {
    // Comments stripped: the file explains *why* it does not set these.
    expect(stripComments(layout)).not.toMatch(/maximumScale|maximum-scale|userScalable/);
  });
});

describe('no physical direction styling', () => {
  // Physical properties that have a logical counterpart. `text-align` is
  // excluded from the CSS-property list because `text-align: start` is itself
  // the logical form; the *values* left/right are what the class scan catches.
  const PHYSICAL_CSS =
    /(^|[\s;{"'`])(margin|padding)-(left|right)\s*:|(^|[\s;{"'`])border-(left|right)(-\w+)?\s*:|(^|[\s;{"'`])(left|right)\s*:\s*(?!auto\b)/;

  const PHYSICAL_UTILITY =
    /(["'\s:])-?(ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|left|right)-|(["'\s:])text-(left|right)(["'\s]|$)/;

  const PHYSICAL_JS_PROPERTY =
    /\b(marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight|borderTopLeftRadius|borderTopRightRadius|borderBottomLeftRadius|borderBottomRightRadius)\b\s*:/;

  it.each(FILES.map((file) => [file.path] as const))('%s uses logical properties only', (file) => {
    const source = stripComments(FILES.find((entry) => entry.path === file)!.source);

    expect(source).not.toMatch(PHYSICAL_CSS);
    expect(source).not.toMatch(PHYSICAL_UTILITY);
    expect(source).not.toMatch(PHYSICAL_JS_PROPERTY);
  });

  it('actually uses the logical equivalents somewhere', () => {
    // Guards against the scan passing because the styles were never written.
    const all = FILES.map((file) => file.source).join('\n');
    expect(all).toMatch(/border-inline-end|border-e|\bms-|\bme-|\bps-|\bpe-|text-start/);
  });
});

describe('nothing secret reaches the browser bundle', () => {
  it('reads no environment variable outside the four public ones', () => {
    const allowed = new Set([
      'NEXT_PUBLIC_API_BASE_URL',
      'NEXT_PUBLIC_KEYCLOAK_URL',
      'NEXT_PUBLIC_KEYCLOAK_REALM',
      'NEXT_PUBLIC_KEYCLOAK_CLIENT_ID',
      'NODE_ENV',
    ]);

    for (const file of FILES) {
      for (const match of stripComments(file.source).matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        expect({ file: file.path, variable: match[1] }).toEqual({
          file: file.path,
          variable: expect.stringMatching(
            new RegExp(`^(${[...allowed].join('|')})$`),
          ) as unknown as string,
        });
      }
    }
  });

  it('embeds no client secret and never asks for a password', () => {
    const all = FILES.map((file) => stripComments(file.source)).join('\n');

    expect(all).not.toMatch(/client_secret|clientSecret/);
    // A password grant would have to name it.
    expect(all).not.toMatch(/grant_type|password['"]?\s*:/);
    expect(all).not.toMatch(/type=["']password["']/);
  });

  it('puts no token in localStorage', () => {
    // docs/16 § 16.11. `sessionStorage` is used for the PKCE state and the
    // tenant choice, neither of which is a token.
    const all = FILES.map((file) => stripComments(file.source)).join('\n');
    expect(all).not.toMatch(/localStorage\.setItem|localStorage\.getItem/);
  });

  it('uses no dangerouslySetInnerHTML', () => {
    const all = FILES.map((file) => stripComments(file.source)).join('\n');
    expect(all).not.toMatch(/dangerouslySetInnerHTML/);
  });
});

describe('only the API boundary talks to the network', () => {
  it('calls fetch in exactly one module', () => {
    const callers = FILES.filter(
      (file) =>
        !file.path.startsWith('test/') &&
        /(^|[^.\w])fetch\s*\(|fetchImpl\s*\(/.test(stripComments(file.source)),
    ).map((file) => file.path);

    expect(callers).toEqual(['lib/api/client.ts']);
  });

  it('never names a service port', () => {
    // Browser-to-service traffic bypasses every control ADR-009 puts in the
    // gateway. The gateway's own port is the only one this application knows.
    const all = FILES.map((file) => stripComments(file.source)).join('\n');
    for (const port of [3101, 3102, 3103, 3104, 3105, 3106, 3112, 3113, 3114, 3115, 3116]) {
      expect(all).not.toContain(`localhost:${port}`);
    }
  });
});
