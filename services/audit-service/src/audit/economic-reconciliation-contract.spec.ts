import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ECONOMIC_RECONCILIATION_CONTRACT,
  paymentReconciliationOperatorActionPayload,
  paymentReconciliationResolvedPayload,
} from './economic-reconciliation-contract';

/**
 * The pinned copy of economic's two payload contracts is economic's contract,
 * declaration for declaration (D-046, Codex on #204).
 *
 * Both files are read as text — economic's is never imported (A-02) — and each
 * declaration the copy carries is compared with comments and whitespace
 * removed. A change to any of them in economic-service fails here until the
 * copy is re-taken, so audit-service cannot go on accepting (or refusing) a
 * payload by a contract economic no longer publishes.
 */

const ECONOMIC_SOURCE = readFileSync(
  join(__dirname, '..', '..', '..', 'economic-service', 'src', 'events', 'events.ts'),
  'utf8',
);
const PINNED_SOURCE = readFileSync(join(__dirname, 'economic-reconciliation-contract.ts'), 'utf8');

/** Every declaration the pinned copy carries, by name. */
const PINNED_DECLARATIONS = [
  'amountMinor',
  'currency',
  'reconciliationKind',
  'unfinishedRefundMarker',
  'EVIDENCE_REFERENCE_PATTERN',
  'evidenceReference',
  'paymentReconciliationResolvedPayload',
  'paymentReconciliationOperatorActionPayload',
] as const;

/** Removes block comments and whole-line `//` comments; leaves code (and regex literals) alone. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The text of `[export ]const <name> = …;` — from the declaration to the first
 * `;` at bracket depth zero — with all whitespace removed.
 */
function declaration(source: string, name: string): string {
  const text = withoutComments(source);
  const start = new RegExp(`^(?:export )?const ${name} = `, 'm').exec(text);
  if (!start) throw new Error(`const ${name} is not declared`);
  let depth = 0;
  for (let index = start.index; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ';' && depth === 0) {
      return text.slice(start.index, index + 1).replace(/\s+/g, '');
    }
  }
  throw new Error(`const ${name} has no end`);
}

/** The pinned region of the copy: everything between its two markers. */
function pinnedRegion(): string {
  const begin = PINNED_SOURCE.indexOf('// --- BEGIN PINNED COPY');
  const end = PINNED_SOURCE.indexOf('// --- END PINNED COPY ---');
  if (begin < 0 || end < begin) throw new Error('the pinned markers are missing');
  return PINNED_SOURCE.slice(begin, end);
}

describe("the pinned copy of economic's reconciliation contract", () => {
  it.each(PINNED_DECLARATIONS)('declares %s exactly as economic does', (name) => {
    expect(declaration(PINNED_SOURCE, name)).toBe(declaration(ECONOMIC_SOURCE, name));
  });

  it('carries nothing between its markers but those declarations', () => {
    // Every `const` in the pinned region is one of the compared ones, so a
    // local tweak cannot hide in a declaration this test does not look at.
    const declared = [...withoutComments(pinnedRegion()).matchAll(/^(?:export )?const (\w+) =/gm)]
      .map((match) => match[1])
      .sort();
    expect(declared).toEqual([...PINNED_DECLARATIONS].sort());
  });

  it('maps each event name to its own schema', () => {
    expect(ECONOMIC_RECONCILIATION_CONTRACT.PAYMENT_RECONCILIATION_RESOLVED).toBe(
      paymentReconciliationResolvedPayload,
    );
    expect(ECONOMIC_RECONCILIATION_CONTRACT.PAYMENT_RECONCILIATION_OPERATOR_ACTION).toBe(
      paymentReconciliationOperatorActionPayload,
    );
  });

  it('fails when a declaration differs (negative control)', () => {
    const tampered = ECONOMIC_SOURCE.replace(
      'const amountMinor = z.string().regex(/^\\d{1,30}$/);',
      'const amountMinor = z.string();',
    );
    expect(tampered).not.toBe(ECONOMIC_SOURCE);
    expect(declaration(tampered, 'amountMinor')).not.toBe(
      declaration(PINNED_SOURCE, 'amountMinor'),
    );
  });
});
