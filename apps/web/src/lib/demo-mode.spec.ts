import { MONEY_EFFECTS, mayOffer, type MoneyEffect } from './demo-mode';
import { IRREVERSIBLE_COMMANDS, ORDER_COMMANDS } from './order-fields';
import { STATEMENT_COMMANDS } from './statement-fields';

/**
 * The one classification every money screen withholds by while the provider
 * is unknown (Q-14). The expectations are written out rather than derived, so
 * reclassifying an action is a visible change here, not a side effect.
 */

describe('mayOffer', () => {
  it.each([
    ['SIMULATED', 'SETTLEMENT', true],
    ['REAL', 'HOLD', true],
    ['UNKNOWN', 'HOLD', false],
    ['UNKNOWN', 'SETTLEMENT', false],
    ['UNKNOWN', 'REFUND', false],
    ['UNKNOWN', 'SETTLEMENT_OR_REFUND', false],
    ['UNKNOWN', 'REWARD_CREDIT', false],
    ['REAL', 'REWARD_CREDIT', true],
    ['UNKNOWN', 'DEPOSIT', false],
    ['UNKNOWN', 'NONE', true],
    // An effect the table does not name counts as money (PR 361 r4).
    ['UNKNOWN', undefined, false],
    ['REAL', undefined, true],
  ] as const)('%s, %s → %s', (mode, effect, offered) => {
    expect(mayOffer(mode, effect)).toBe(offered);
  });
});

describe('MONEY_EFFECTS', () => {
  it('withholds the order commands that settle or refund, and only those (Codex PR-361 r2)', () => {
    const withheld = ORDER_COMMANDS.filter(
      (command) => !mayOffer('UNKNOWN', MONEY_EFFECTS.order[command]),
    );
    expect(withheld).toEqual(['CONFIRM_RECEIPT', 'RESOLVE_DISPUTE', 'CANCEL']);
  });

  it('agrees with the commands the order form already asks a second look for', () => {
    const moving = ORDER_COMMANDS.filter((command) => MONEY_EFFECTS.order[command] !== 'NONE');
    expect(new Set(moving)).toEqual(IRREVERSIBLE_COMMANDS);
  });

  it('withholds placing an order: it holds the amount in escrow', () => {
    expect(MONEY_EFFECTS.placeOrder).toBe<MoneyEffect>('HOLD');
    expect(mayOffer('UNKNOWN', MONEY_EFFECTS.placeOrder)).toBe(false);
  });

  it('offers every statement command and the maintenance cost approval: each only records an obligation', () => {
    for (const command of STATEMENT_COMMANDS) {
      expect(mayOffer('UNKNOWN', MONEY_EFFECTS.statement[command])).toBe(true);
    }
    expect(mayOffer('UNKNOWN', MONEY_EFFECTS.maintenanceApproval)).toBe(true);
  });

  it('withholds the two reward triggers: a monetised rule credits the wallet unasked (Codex PR-361 r3)', () => {
    expect(MONEY_EFFECTS.repairCompletion).toBe<MoneyEffect>('REWARD_CREDIT');
    expect(MONEY_EFFECTS.usageRecord).toBe<MoneyEffect>('REWARD_CREDIT');
    expect(mayOffer('UNKNOWN', MONEY_EFFECTS.repairCompletion)).toBe(false);
    expect(mayOffer('UNKNOWN', MONEY_EFFECTS.usageRecord)).toBe(false);
    expect(mayOffer('SIMULATED', MONEY_EFFECTS.repairCompletion)).toBe(true);
    expect(mayOffer('REAL', MONEY_EFFECTS.usageRecord)).toBe(true);
  });

  it('withholds the wallet top-up: a deposit through the provider (PR 361 r4)', () => {
    expect(MONEY_EFFECTS.walletTopUp).toBe<MoneyEffect>('DEPOSIT');
    expect(mayOffer('UNKNOWN', MONEY_EFFECTS.walletTopUp)).toBe(false);
  });
});
