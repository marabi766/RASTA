/**
 * @jest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { NON_STANDARD_SPELLING } from '@/test/orthography';

/**
 * The product's Persian is in standard orthography, hamza included (owner
 * decision 2026-10-24: تأمین، تأیید، مسئول). This replaces the earlier
 * product-side "no hamza" rule; that rule belongs to PM reports and Telegram.
 * Every source file the portal ships is checked, so a hamza-less spelling or a
 * combining hamza (U+0654) cannot reach a screen from any module.
 */
const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    // `test/` holds support code for the specs (it lists the wrong spellings to catch them).
    if (statSync(path).isDirectory()) return entry === 'test' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.(spec|test)\./.test(entry) ? [path] : [];
  });
}

describe('standard Persian orthography', () => {
  it('finds the portal sources', () => {
    expect(sources(SRC).length).toBeGreaterThan(200);
  });

  it('has no hamza-less spelling and no combining hamza on alef, waw or yeh in any shipped source file', () => {
    const offenders = sources(SRC).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, at: `${relative(SRC, file)}:${index + 1}` }))
        .filter(({ line }) => NON_STANDARD_SPELLING.test(line))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });

  it('recognises the spellings it exists to catch, and not the standard ones', () => {
    // Built from code points: this file carries no wrong spelling as text.
    const word = (...codes: number[]) => String.fromCodePoint(...codes);
    const hamzaLess = word(0x062a, 0x0627, 0x0645, 0x06cc, 0x0646); // alef without hamza
    const combining = word(0x062a, 0x0627, 0x0654, 0x0645, 0x06cc, 0x0646);
    const standard = word(0x062a, 0x0623, 0x0645, 0x06cc, 0x0646);
    expect(NON_STANDARD_SPELLING.test(hamzaLess)).toBe(true);
    expect(NON_STANDARD_SPELLING.test(combining)).toBe(true);
    expect(NON_STANDARD_SPELLING.test(standard)).toBe(false);
    // The ezafe: heh + combining hamza is the standard spelling of «شمارهٔ دارایی».
    expect(NON_STANDARD_SPELLING.test(word(0x0634, 0x0645, 0x0627, 0x0631, 0x0647, 0x0654))).toBe(
      false,
    );
  });
});
