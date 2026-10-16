import { RastaError } from '@rasta/nest-common';
import { effectiveDatedChange } from './commission.service';

/**
 * A rule's status and window change only from now on (docs/23 D-057; Codex
 * round 1 on #307, F2). `trg_commission_rule_effective_dated` holds the same
 * rules in the database; `commission-pricing-integrity.int-spec.ts` proves both.
 */
describe('effectiveDatedChange', () => {
  const NOW = new Date('2026-10-16T12:00:00.000Z');
  const HOUR = 3_600_000;
  const at = (offsetHours: number) => new Date(NOW.getTime() + offsetHours * HOUR);

  const inForce = { status: 'ACTIVE' as const, validFrom: at(-24), validTo: null };
  const notStarted = { status: 'ACTIVE' as const, validFrom: at(24), validTo: null };
  const withdrawn = { status: 'INACTIVE' as const, validFrom: at(24), validTo: null };

  function refusal(run: () => unknown): string {
    try {
      run();
    } catch (error) {
      if (error instanceof RastaError) return error.message;
      throw error;
    }
    throw new Error('expected a refusal');
  }

  it('ends a rule in force now when it is deactivated, and keeps its status', () => {
    // A status flip would have taken the rule away from every instant it had
    // already covered; ending it now leaves those instants as they were.
    expect(effectiveDatedChange(inForce, { status: 'INACTIVE' }, NOW)).toEqual({ validTo: NOW });
  });

  it('withdraws a rule that has not started, which never applied to anything', () => {
    expect(effectiveDatedChange(notStarted, { status: 'INACTIVE' }, NOW)).toEqual({
      status: 'INACTIVE',
    });
  });

  it('reinstates a withdrawn rule only while its start is still ahead', () => {
    expect(effectiveDatedChange(withdrawn, { status: 'ACTIVE' }, NOW)).toEqual({
      status: 'ACTIVE',
    });
    const started = { ...withdrawn, validFrom: at(-1) };
    expect(refusal(() => effectiveDatedChange(started, { status: 'ACTIVE' }, NOW))).toMatch(
      /cannot be reinstated/,
    );
  });

  it('refuses to deactivate an ended rule or to send both forms of ending at once', () => {
    const ended = { ...inForce, validTo: at(-1) };
    expect(refusal(() => effectiveDatedChange(ended, { status: 'INACTIVE' }, NOW))).toMatch(
      /already ended/,
    );
    expect(
      refusal(() =>
        effectiveDatedChange(inForce, { status: 'INACTIVE', validTo: at(5).toISOString() }, NOW),
      ),
    ).toMatch(/not both/);
  });

  it('moves an end only forward, by the clock it is given', () => {
    expect(effectiveDatedChange(inForce, { validTo: at(2).toISOString() }, NOW)).toEqual({
      validTo: at(2),
    });
    expect(
      refusal(() => effectiveDatedChange(inForce, { validTo: at(-2).toISOString() }, NOW)),
    ).toMatch(/never in the past/);
  });

  it('treats a status it already has as no status change', () => {
    expect(effectiveDatedChange(inForce, { status: 'ACTIVE' }, NOW)).toEqual({});
  });
});
