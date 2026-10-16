import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INITIAL_STATEMENT_STATE,
  STATEMENT_COMMANDS,
  STATEMENT_STATES,
  STATEMENT_TRANSITIONS,
  canStatementTransition,
  statementTransitionFor,
  type StatementStateName,
} from './statement.state-machine';

/** Every (from, to) pair this change declares — and only those. */
const DECLARED: ReadonlyArray<readonly [StatementStateName, StatementStateName]> = [
  ['DRAFT', 'SUBMITTED'],
];

const migration = (name: string): string =>
  readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', name, 'migration.sql'), 'utf8');

describe('the statement lifecycle', () => {
  it('declares the five states of ADR-068 § 5, in order', () => {
    expect([...STATEMENT_STATES]).toEqual([
      'DRAFT',
      'SUBMITTED',
      'TECHNICALLY_APPROVED',
      'APPROVED',
      'REJECTED',
    ]);
  });

  it('opens exactly DRAFT → SUBMITTED: the decisions of the two chains are the next change', () => {
    expect(STATEMENT_TRANSITIONS.map((entry) => [entry.from, entry.to])).toEqual(DECLARED);
  });

  it('walks every (from, to) pair: only the declared one is a transition', () => {
    for (const from of STATEMENT_STATES) {
      for (const to of STATEMENT_STATES) {
        const declared = DECLARED.some(([a, b]) => a === from && b === to);
        expect([from, to, canStatementTransition(from, to)]).toEqual([from, to, declared]);
      }
    }
  });

  it('starts DRAFT, and submit moves a draft and nothing else', () => {
    expect(INITIAL_STATEMENT_STATE).toBe('DRAFT');
    expect([...STATEMENT_COMMANDS]).toEqual(['submit']);
    expect(statementTransitionFor('DRAFT', 'submit')?.to).toBe('SUBMITTED');
    for (const from of STATEMENT_STATES.filter((state) => state !== 'DRAFT')) {
      expect(statementTransitionFor(from, 'submit')).toBeUndefined();
    }
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(STATEMENT_TRANSITIONS)).toBe(true);
    for (const entry of STATEMENT_TRANSITIONS) expect(Object.isFrozen(entry)).toBe(true);
  });

  it('is the table the latest migration header lists and its guard allows, over the enum the database declares', () => {
    const sql = migration('20261016120000_statement_submission');
    const listed = /^--\s+statement transitions:\s*(.+)$/m.exec(sql)?.[1]?.trim().split(/\s+/);
    expect(listed).toEqual(STATEMENT_TRANSITIONS.map((entry) => `${entry.from}>${entry.to}`));
    // The guard's own text allows the same single transition and no other.
    const guard =
      /CREATE OR REPLACE FUNCTION "statement_guard"\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/.exec(
        sql,
      )?.[0];
    expect(guard).toContain(`IF NOT (OLD."status" = 'DRAFT' AND NEW."status" = 'SUBMITTED') THEN`);
    expect(guard?.match(/NEW\."status" = '/g)).toHaveLength(1);
    const declared = /CREATE TYPE "StatementStatus" AS ENUM \(([^)]*)\)/.exec(
      migration('20261015120000_statements'),
    )?.[1];
    expect(declared?.split(',').map((value) => value.trim().replace(/'/g, ''))).toEqual([
      ...STATEMENT_STATES,
    ]);
  });
});
