import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GOVERNING_POLICY_STATE,
  POLICY_STATES,
  POLICY_TRANSITIONS,
  assertPolicyTransition,
  canTransitionPolicy,
  type PolicyStateName,
} from './policy.state-machine';

/** Every (from, to) pair the lifecycle declares — and only those. */
const DECLARED: ReadonlyArray<readonly [PolicyStateName, PolicyStateName]> = [
  ['DRAFT', 'PENDING_PLATFORM_APPROVAL'],
  ['PENDING_PLATFORM_APPROVAL', 'ACTIVE'],
  ['PENDING_PLATFORM_APPROVAL', 'REJECTED'],
  ['ACTIVE', 'RETIRED'],
];

describe('the approval policy lifecycle', () => {
  it('walks every (from, to) pair: only the declared ones are transitions', () => {
    for (const from of POLICY_STATES) {
      for (const to of POLICY_STATES) {
        const declared = DECLARED.some(([a, b]) => a === from && b === to);
        expect([from, to, canTransitionPolicy(from, to)]).toEqual([from, to, declared]);
      }
    }
  });

  it('lets nothing leave REJECTED or RETIRED, and only ACTIVE governs', () => {
    expect(POLICY_TRANSITIONS.REJECTED).toEqual([]);
    expect(POLICY_TRANSITIONS.RETIRED).toEqual([]);
    expect(GOVERNING_POLICY_STATE).toBe('ACTIVE');
  });

  it('refuses an undeclared move as a business rule, naming the policy and the states', () => {
    expect(() => assertPolicyTransition('APL_1', 'DRAFT', 'ACTIVE')).toThrow(
      /Approval policy APL_1 cannot move from DRAFT to ACTIVE/,
    );
    expect(() =>
      assertPolicyTransition('APL_1', 'DRAFT', 'PENDING_PLATFORM_APPROVAL'),
    ).not.toThrow();
  });

  it('is the table the database keeps (approval_policy_guard)', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'prisma',
        'migrations',
        '20261005150000_signing_policy',
        'migration.sql',
      ),
      'utf8',
    );
    const listed = /--\s+transitions:\s*(.+)/.exec(sql)?.[1]?.trim().split(/\s+/) ?? [];
    expect(listed).toEqual(DECLARED.map(([from, to]) => `${from}>${to}`));
  });
});
