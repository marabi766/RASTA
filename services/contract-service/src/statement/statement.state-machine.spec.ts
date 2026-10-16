import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INITIAL_STATEMENT_STATE,
  STATEMENT_STATES,
  STATEMENT_TRANSITIONS,
  canStatementTransition,
} from './statement.state-machine';

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

  it('opens no transition yet: submission comes with the approval chains and their snapshot', () => {
    expect(STATEMENT_TRANSITIONS).toEqual([]);
  });

  it('walks every (from, to) pair: none is a transition', () => {
    for (const from of STATEMENT_STATES) {
      for (const to of STATEMENT_STATES) {
        expect([from, to, canStatementTransition(from, to)]).toEqual([from, to, false]);
      }
    }
  });

  it('starts DRAFT', () => {
    expect(INITIAL_STATEMENT_STATE).toBe('DRAFT');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(STATEMENT_TRANSITIONS)).toBe(true);
  });

  it('is the table the migration header lists, and the enum the database declares', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'prisma',
        'migrations',
        '20261015120000_statements',
        'migration.sql',
      ),
      'utf8',
    );
    const listed = /^--\s+statement transitions:\s*(.+)$/m.exec(sql)?.[1]?.trim();
    expect(listed).toBe('(none)');
    // The guard's own text refuses every move once the terms are checked, and names no state to
    // move to.
    const guard = /CREATE FUNCTION "statement_guard"\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/.exec(
      sql,
    )?.[0];
    expect(guard).toContain(
      `RAISE EXCEPTION 'ck_statement_transition: no statement transition is open yet`,
    );
    expect(guard).not.toMatch(/NEW\."status" = '/);
    const declared = /CREATE TYPE "StatementStatus" AS ENUM \(([^)]*)\)/.exec(sql)?.[1];
    expect(declared?.split(',').map((value) => value.trim().replace(/'/g, ''))).toEqual([
      ...STATEMENT_STATES,
    ]);
  });
});
