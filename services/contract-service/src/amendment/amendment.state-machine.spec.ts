import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AMENDMENT_COMMANDS,
  AMENDMENT_STATES,
  AMENDMENT_TRANSITIONS,
  FINAL_AMENDMENT_STATES,
  INITIAL_AMENDMENT_STATE,
  amendmentTransitionFor,
  canAmendmentTransition,
  type AmendmentStateName,
} from './amendment.state-machine';

/** Every (from, to) pair the lifecycle declares — and only those. */
const DECLARED: ReadonlyArray<readonly [AmendmentStateName, AmendmentStateName]> = [
  ['PROPOSED', 'EFFECTIVE'],
];

describe('the amendment lifecycle', () => {
  it('declares exactly PROPOSED → EFFECTIVE', () => {
    expect(AMENDMENT_TRANSITIONS.map((entry) => [entry.from, entry.to])).toEqual(DECLARED);
  });

  it('walks every (from, to) pair: only the declared one is a transition', () => {
    for (const from of AMENDMENT_STATES) {
      for (const to of AMENDMENT_STATES) {
        const declared = DECLARED.some(([a, b]) => a === from && b === to);
        expect([from, to, canAmendmentTransition(from, to)]).toEqual([from, to, declared]);
      }
    }
  });

  it('starts PROPOSED and lets nothing leave EFFECTIVE: no withdrawal, no reversal (Q-100)', () => {
    expect(INITIAL_AMENDMENT_STATE).toBe('PROPOSED');
    expect([...FINAL_AMENDMENT_STATES]).toEqual(['EFFECTIVE']);
    for (const final of FINAL_AMENDMENT_STATES) {
      expect(AMENDMENT_TRANSITIONS.filter((entry) => entry.from === final)).toEqual([]);
    }
  });

  it('gives the one command the one transition, and none from EFFECTIVE', () => {
    for (const command of AMENDMENT_COMMANDS) {
      expect(AMENDMENT_TRANSITIONS.filter((entry) => entry.command === command)).toHaveLength(1);
    }
    expect(amendmentTransitionFor('PROPOSED', 'sign')?.to).toBe('EFFECTIVE');
    expect(amendmentTransitionFor('EFFECTIVE', 'sign')).toBeUndefined();
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(AMENDMENT_TRANSITIONS)).toBe(true);
    for (const entry of AMENDMENT_TRANSITIONS) expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(FINAL_AMENDMENT_STATES)).toBe(true);
  });

  it('is the table the migration header lists, which the database guard enforces', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'prisma',
        'migrations',
        '20261007100000_amendments_milestones',
        'migration.sql',
      ),
      'utf8',
    );
    const listed = /^--\s+amendment transitions:\s*(.+)$/m.exec(sql)?.[1]?.trim().split(/\s+/);
    expect(listed).toEqual(AMENDMENT_TRANSITIONS.map((entry) => `${entry.from}>${entry.to}`));
    // The guard's own text allows the same single transition and no other.
    expect(sql).toContain(`NEW."status" = 'EFFECTIVE'`);
    expect(sql).toContain(`OLD."status" = 'EFFECTIVE'`);
  });
});
