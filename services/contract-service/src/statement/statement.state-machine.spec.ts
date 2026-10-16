import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FINAL_STATEMENT_STATES,
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
  ['SUBMITTED', 'TECHNICALLY_APPROVED'],
  ['SUBMITTED', 'REJECTED'],
  ['TECHNICALLY_APPROVED', 'APPROVED'],
  ['TECHNICALLY_APPROVED', 'REJECTED'],
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

  it('opens the submission and the decisions: technical, then financial, a rejection from either', () => {
    expect(STATEMENT_TRANSITIONS.map((entry) => [entry.from, entry.to])).toEqual(DECLARED);
  });

  it('walks every (from, to) pair: only the declared ones are transitions', () => {
    for (const from of STATEMENT_STATES) {
      for (const to of STATEMENT_STATES) {
        const declared = DECLARED.some(([a, b]) => a === from && b === to);
        expect([from, to, canStatementTransition(from, to)]).toEqual([from, to, declared]);
      }
    }
  });

  it('starts DRAFT; each command moves exactly the states it names; APPROVED and REJECTED are final', () => {
    expect(INITIAL_STATEMENT_STATE).toBe('DRAFT');
    expect([...STATEMENT_COMMANDS]).toEqual([
      'submit',
      'approve_technical',
      'approve_financial',
      'reject',
    ]);
    const moves = (command: (typeof STATEMENT_COMMANDS)[number]) =>
      STATEMENT_STATES.flatMap((from) => {
        const to = statementTransitionFor(from, command)?.to;
        return to ? [`${from}>${to}`] : [];
      });
    expect(moves('submit')).toEqual(['DRAFT>SUBMITTED']);
    expect(moves('approve_technical')).toEqual(['SUBMITTED>TECHNICALLY_APPROVED']);
    expect(moves('approve_financial')).toEqual(['TECHNICALLY_APPROVED>APPROVED']);
    expect(moves('reject')).toEqual(['SUBMITTED>REJECTED', 'TECHNICALLY_APPROVED>REJECTED']);
    expect([...FINAL_STATEMENT_STATES]).toEqual(['APPROVED', 'REJECTED']);
    for (const final of FINAL_STATEMENT_STATES) {
      expect(STATEMENT_TRANSITIONS.filter((entry) => entry.from === final)).toEqual([]);
    }
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(STATEMENT_TRANSITIONS)).toBe(true);
    for (const entry of STATEMENT_TRANSITIONS) expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(FINAL_STATEMENT_STATES)).toBe(true);
  });

  it('is the table the latest migration header lists and its guard allows, over the enum the database declares', () => {
    const sql = migration('20261016180000_statement_decisions');
    const table = STATEMENT_TRANSITIONS.map((entry) => `${entry.from}>${entry.to}`);
    const listed = /^--\s+statement transitions:\s*(.+)$/m.exec(sql)?.[1]?.trim().split(/\s+/);
    expect(listed).toEqual(table);
    // The guard's own list allows the same transitions and no other; a decision that completes
    // nothing keeps a SUBMITTED or TECHNICALLY_APPROVED status, and the final states never change.
    const guard =
      /CREATE OR REPLACE FUNCTION "statement_guard"\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/.exec(
        sql,
      )?.[0];
    const allowed = /= ANY \(ARRAY\[([^\]]*)\]\)/
      .exec(guard ?? '')?.[1]
      ?.split(',')
      .map((value) => value.trim().replace(/'/g, ''));
    expect(allowed).toEqual(table);
    expect(guard).toContain(
      `NOT (NEW."status" = OLD."status" AND OLD."status" IN ('SUBMITTED', 'TECHNICALLY_APPROVED'))`,
    );
    expect(guard).toContain(`IF OLD."status" IN ('APPROVED', 'REJECTED') THEN`);
    const declared = /CREATE TYPE "StatementStatus" AS ENUM \(([^)]*)\)/.exec(
      migration('20261015120000_statements'),
    )?.[1];
    expect(declared?.split(',').map((value) => value.trim().replace(/'/g, ''))).toEqual([
      ...STATEMENT_STATES,
    ]);
  });
});
