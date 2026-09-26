import { CORRECTION_OF } from './journal-reversal.service';

/**
 * Which journals the generic reversal may post (global audit L7-07).
 *
 * The table is typed over the whole `JournalType` enum, so a new type does not
 * compile without an entry; this pins what each entry says.
 */
describe('CORRECTION_OF', () => {
  it('leaves only a reversal to the ledger, which refuses it itself', () => {
    const unowned = Object.entries(CORRECTION_OF)
      .filter(([, correction]) => correction === null)
      .map(([type]) => type);
    expect(unowned).toEqual(['REVERSAL']);
  });

  it('names the operation where one exists, and the open question where none does', () => {
    expect(CORRECTION_OF.WALLET_TOP_UP).toContain('POST /v1/payment-intents/{id}/refund');
    expect(CORRECTION_OF.FUNDS_HELD).toContain('POST /v1/transactions/{id}/refund');
    for (const type of ['FUNDS_REFUNDED', 'SETTLEMENT', 'REWARD_GRANT'] as const) {
      expect(CORRECTION_OF[type]).toContain('docs/24 Q-76');
    }
  });
});
