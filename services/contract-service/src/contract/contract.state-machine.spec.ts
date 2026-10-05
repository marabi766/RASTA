import {
  CONTRACT_COMMANDS,
  CONTRACT_STATES,
  CONTRACT_TRANSITIONS,
  FINAL_CONTRACT_STATES,
  INITIAL_CONTRACT_STATE,
  canTransition,
  transitionFor,
  type ContractStateName,
} from './contract.state-machine';

/** Every (from, to) pair the lifecycle declares — and only those. */
const DECLARED: ReadonlyArray<readonly [ContractStateName, ContractStateName]> = [
  ['DRAFT', 'SIGNED'],
  ['DRAFT', 'CANCELLED'],
  ['SIGNED', 'COMPLETED'],
  ['COMPLETED', 'SETTLED'],
];

describe('the contract lifecycle', () => {
  it('declares exactly the transitions of ADR-068 § 2', () => {
    expect(CONTRACT_TRANSITIONS.map((entry) => [entry.from, entry.to])).toEqual(DECLARED);
  });

  it('walks every (from, to) pair: only the declared ones are transitions', () => {
    for (const from of CONTRACT_STATES) {
      for (const to of CONTRACT_STATES) {
        const declared = DECLARED.some(([a, b]) => a === from && b === to);
        expect([from, to, canTransition(from, to)]).toEqual([from, to, declared]);
      }
    }
  });

  it('starts in DRAFT, which is the only state the consumer creates', () => {
    expect(INITIAL_CONTRACT_STATE).toBe('DRAFT');
  });

  it('lets nothing leave a final state', () => {
    for (const final of FINAL_CONTRACT_STATES) {
      expect(CONTRACT_TRANSITIONS.filter((entry) => entry.from === final)).toEqual([]);
    }
    expect([...FINAL_CONTRACT_STATES]).toEqual(['SETTLED', 'CANCELLED']);
  });

  it('gives every command exactly one transition, and no two transitions one command', () => {
    for (const command of CONTRACT_COMMANDS) {
      expect(CONTRACT_TRANSITIONS.filter((entry) => entry.command === command)).toHaveLength(1);
    }
    expect(transitionFor('DRAFT', 'sign')?.to).toBe('SIGNED');
    expect(transitionFor('SIGNED', 'sign')).toBeUndefined();
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(CONTRACT_TRANSITIONS)).toBe(true);
    for (const entry of CONTRACT_TRANSITIONS) expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(FINAL_CONTRACT_STATES)).toBe(true);
  });

  it('keeps a contract that was signed from being cancelled (Q-95 (4), provisional)', () => {
    expect(canTransition('SIGNED', 'CANCELLED')).toBe(false);
  });
});
