import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEDUCTION_CHANGE_STATES,
  DEDUCTION_CHANGE_TRANSITIONS,
  assertDeductionChangeTransition,
  canTransitionDeductionChange,
  type DeductionChangeState,
} from './deduction-rule-change.state-machine';

/** Every (from, to) pair the lifecycle declares, and only those. */
const DECLARED: ReadonlyArray<readonly [DeductionChangeState, DeductionChangeState]> = [
  ['PENDING_APPROVAL', 'APPROVED'],
  ['PENDING_APPROVAL', 'REJECTED'],
  ['PENDING_APPROVAL', 'WITHDRAWN'],
];

describe('the deduction rule change lifecycle', () => {
  it('walks every (from, to) pair: only the declared ones are transitions', () => {
    for (const from of DEDUCTION_CHANGE_STATES) {
      for (const to of DEDUCTION_CHANGE_STATES) {
        const declared = DECLARED.some(([a, b]) => a === from && b === to);
        expect([from, to, canTransitionDeductionChange(from, to)]).toEqual([from, to, declared]);
      }
    }
  });

  it('lets nothing leave a decided change', () => {
    expect(DEDUCTION_CHANGE_TRANSITIONS.APPROVED).toEqual([]);
    expect(DEDUCTION_CHANGE_TRANSITIONS.REJECTED).toEqual([]);
    expect(DEDUCTION_CHANGE_TRANSITIONS.WITHDRAWN).toEqual([]);
  });

  it('refuses an undeclared move as a business rule, naming the change and the states', () => {
    expect(() => assertDeductionChangeTransition('DRC_1', 'APPROVED', 'WITHDRAWN')).toThrow(
      /Deduction rule change DRC_1 cannot move from APPROVED to WITHDRAWN/,
    );
    expect(() =>
      assertDeductionChangeTransition('DRC_1', 'PENDING_APPROVAL', 'APPROVED'),
    ).not.toThrow();
  });

  it('is the table the migration declares; test/deduction-rule-change.int-spec.ts walks the real trigger', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'prisma',
        'migrations',
        '20261104100000_deduction_rule_changes',
        'migration.sql',
      ),
      'utf8',
    );
    const listed = /--\s+transitions:\s*(.+)/.exec(sql)?.[1]?.trim().split(/\s+/) ?? [];
    expect(listed).toEqual(DECLARED.map(([from, to]) => `${from}>${to}`));
  });
});
