/**
 * @jest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Two source guards for the phone layout (demo run 2026-10-24, defects 5 and 6).
 * They are structural: a screen written tomorrow is held to the same rule
 * without anybody remembering it.
 */

const SRC = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === 'test' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.(spec|test)\.|fixture/.test(entry) ? [path] : [];
  });
}

const FILES = sources(SRC).map((path) => ({
  name: relative(SRC, path).split('\\').join('/'),
  text: readFileSync(path, 'utf8'),
}));

/**
 * The tables a screen draws are wrapped, every one. A table wider than the
 * screen otherwise makes the **page** scroll sideways (wallet 559 px and
 * product page 481 px at a 390 px phone); inside `TableScroll` only the table
 * moves, and the region is a named keyboard stop.
 *
 * The check is deliberately literal: the tag before `<table` must be a
 * `<TableScroll label="…">` opening and the tag after `</table>` its closing.
 * A table that cannot be proven wrapped is a failure, not an exemption.
 */
describe('every table scrolls inside TableScroll', () => {
  const TABLE = /<table\b[\s\S]*?<\/table>/g;

  it('finds the tables this guard is about (not vacuous)', () => {
    const count = FILES.reduce((total, file) => total + (file.text.match(TABLE)?.length ?? 0), 0);
    expect(count).toBeGreaterThanOrEqual(15);
  });

  it('has no table outside a labelled TableScroll', () => {
    const unwrapped: string[] = [];
    for (const file of FILES) {
      for (const match of file.text.matchAll(TABLE)) {
        const before = file.text.slice(0, match.index).trimEnd();
        const after = file.text.slice((match.index ?? 0) + match[0].length).trimStart();
        const opening = /<TableScroll\s+label=(?:"[^"]+"|\{[^}]+\})\s*>$/.test(before);
        const closing = after.startsWith('</TableScroll>');
        if (!opening || !closing) unwrapped.push(file.name);
      }
    }
    expect(unwrapped).toEqual([]);
  });
});

/**
 * Persian letters are never drawn in a monospace face or letter-spaced: the
 * browser falls back glyph by glyph and a joined script comes apart (defect 6).
 * `Identifier` decides from the value (Latin codes only). The two request-id
 * links below are the only other users of the face; their text is an id.
 */
describe('monospace and letter-spacing', () => {
  const MONO_ALLOWED = new Set([
    'ui/text/Identifier.tsx',
    'app/maintenance/MaintenanceScreen.tsx',
    'app/maintenance/[id]/RequestDetailScreen.tsx',
  ]);

  it('keeps font-mono to the files that draw only Latin ids', () => {
    const users = FILES.filter((file) => /\bfont-mono\b/.test(file.text)).map((file) => file.name);
    expect(users.filter((name) => !MONO_ALLOWED.has(name))).toEqual([]);
  });

  it('never letter-spaces text (it breaks Arabic-script joining)', () => {
    const users = FILES.filter((file) => /\btracking-|letter-spacing/.test(file.text)).map(
      (file) => file.name,
    );
    expect(users).toEqual([]);
  });
});

/**
 * A native date control is Gregorian and Latin («mm/dd/yyyy») on a page where
 * every other date is Jalali (defect 7). Every date or date-time input goes
 * through `JalaliDateInput`, which names the format and shows the chosen day in
 * Jalali; a raw one is a failure.
 */
describe('native date inputs', () => {
  const RAW_DATE_INPUT = /<input\b[^<]*?type=["'](?:date|datetime-local)["'][^<]*?\/>/s;

  it('are drawn only by JalaliDateInput', () => {
    const raw = FILES.filter(
      (file) => file.name !== 'ui/form/JalaliDateInput.tsx' && RAW_DATE_INPUT.test(file.text),
    ).map((file) => file.name);
    expect(raw).toEqual([]);
  });

  it('is in use (not vacuous)', () => {
    const users = FILES.filter((file) => /<JalaliDateInput\b/.test(file.text));
    expect(users.length).toBeGreaterThanOrEqual(9);
  });
});
