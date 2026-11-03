/**
 * @jest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ASSET_ID_HINT, ORGANIZATION_ID_HINT } from './id-hints';

/**
 * A form hint never gives an example id (demo run 2026-10-24, defect 11): the
 * platform's ids come both as `AST_01J…` (generated) and `AST-SEED-0001`
 * (seeded), and an example of either shape reads as a correction of the other.
 */
const APP = join(__dirname, '..', 'app');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(entry) && !/\.(spec|test)\./.test(entry) ? [path] : [];
  });
}

// An id-shaped token: a three-letter upper-case prefix, then `_` or `-`, then a code.
const EXAMPLE_ID = /\b[A-Z]{2,4}[_-](?:[0-9A-Z]{2,}|SEED)/;

describe('id hints', () => {
  it('say where to take the id from, with no example shape', () => {
    for (const hint of [ASSET_ID_HINT, ORGANIZATION_ID_HINT]) {
      expect(hint).not.toMatch(EXAMPLE_ID);
      expect(hint).not.toContain('مانند');
    }
  });

  it('are the only hints the forms use for an id', () => {
    const offenders: string[] = [];
    for (const path of sources(APP)) {
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(/\bhint=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        // A template's interpolations are code, not words.
        const hint = (match[1] ?? match[2] ?? '').replace(/\$\{[^}]*\}/g, '');
        if (EXAMPLE_ID.test(hint)) offenders.push(`${path}: ${hint}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
