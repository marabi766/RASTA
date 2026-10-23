/**
 * @jest-environment node
 */
import type { DemoMode, MoneyEffect } from '@/lib/demo-mode';

import { mayDispatch } from './money-gate';
import type { WebSession } from './session';

/**
 * `mayDispatch` on its own, with the read stubbed: what the actions' fake
 * gateway cannot reach — a read that throws past its own catch, an effect the
 * table does not name. The actions themselves are `app/money-actions-gate.spec.ts`.
 */

const SESSION = { accessToken: 'access-token-value' } as WebSession;
const reading = (mode: DemoMode) => jest.fn(async () => mode);

describe('mayDispatch', () => {
  it('sends a command that moves no money without asking', async () => {
    const read = reading('UNKNOWN');
    await expect(mayDispatch(SESSION, 'NONE', read)).resolves.toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it.each<MoneyEffect>([
    'HOLD',
    'SETTLEMENT',
    'REFUND',
    'SETTLEMENT_OR_REFUND',
    'REWARD_CREDIT',
    'DEPOSIT',
  ])('%s: asks with the session, sends for an answer, refuses for UNKNOWN', async (effect) => {
    for (const [mode, sent] of [
      ['SIMULATED', true],
      ['REAL', true],
      ['UNKNOWN', false],
    ] as const) {
      const read = reading(mode);
      await expect(mayDispatch(SESSION, effect, read)).resolves.toBe(sent);
      expect(read).toHaveBeenCalledWith(SESSION);
    }
  });

  it('refuses when the read itself throws — never lets it through or up', async () => {
    const read = jest.fn(async (): Promise<DemoMode> => {
      throw new TypeError('fetch failed');
    });
    await expect(mayDispatch(SESSION, 'SETTLEMENT', read)).resolves.toBe(false);
  });

  it('counts an effect the table does not name as money', async () => {
    await expect(mayDispatch(SESSION, undefined, reading('UNKNOWN'))).resolves.toBe(false);
  });
});
