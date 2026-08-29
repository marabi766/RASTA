import { computeCommission, selectRule, type CommissionRuleView } from './rule-engine';

/**
 * The commission engine.
 *
 * Two of docs/10 § 10.12's mandatory tests live here: **"نرخ زمان تراکنش اعمال
 * می‌شود، نه نرخ فعلی"** — the rate in force when the transaction occurred, not
 * today's — and the rounding rule. The rest exist because a commission engine
 * that silently invents a rate would violate the product document's most
 * explicit financial constraint.
 */

function rule(overrides: Partial<CommissionRuleView> = {}): CommissionRuleView {
  return {
    id: 'CMR_1',
    organizationId: null,
    rateBasisPoints: 250,
    minAmountMinor: null,
    maxAmountMinor: null,
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validTo: null,
    status: 'ACTIVE',
    ...overrides,
  };
}

const AT = new Date('2026-06-01T00:00:00.000Z');

describe('selectRule', () => {
  it('returns null when nothing is configured', () => {
    // The MVP's real state. docs/24 Q-08 is open and no commercial rate is
    // seeded, so this is the path every settlement takes today.
    expect(selectRule([], 'ORG-A', AT)).toBeNull();
  });

  it('ignores an INACTIVE rule', () => {
    expect(selectRule([rule({ status: 'INACTIVE' })], 'ORG-A', AT)).toBeNull();
  });

  it('ignores a rule that had not started when the transaction occurred', () => {
    expect(
      selectRule([rule({ validFrom: new Date('2026-07-01T00:00:00.000Z') })], 'ORG-A', AT),
    ).toBeNull();
  });

  it('ignores a rule that had already ended', () => {
    expect(
      selectRule([rule({ validTo: new Date('2026-05-01T00:00:00.000Z') })], 'ORG-A', AT),
    ).toBeNull();
  });

  it('treats validTo as exclusive, so a replacement can start where the last ended', () => {
    // Half-open intervals: no one-instant overlap and no one-instant gap.
    const boundary = new Date('2026-06-01T00:00:00.000Z');
    expect(selectRule([rule({ validTo: boundary })], 'ORG-A', boundary)).toBeNull();
    expect(selectRule([rule({ validFrom: boundary })], 'ORG-A', boundary)?.id).toBe('CMR_1');
  });

  it('never returns another organization private rule', () => {
    // A negotiated rate is commercially sensitive. Organization B must not be
    // charged — or even matched against — organization A's arrangement.
    expect(selectRule([rule({ organizationId: 'ORG-A' })], 'ORG-B', AT)).toBeNull();
  });

  it('prefers an organization-specific rule over a platform-wide one', () => {
    // How a negotiated arrangement is expressed without branching the code
    // (docs/10 § 10.7).
    const chosen = selectRule(
      [rule({ id: 'GLOBAL', organizationId: null }), rule({ id: 'OWN', organizationId: 'ORG-A' })],
      'ORG-A',
      AT,
    );
    expect(chosen?.id).toBe('OWN');
  });

  it('prefers the latest validFrom among rules of equal specificity', () => {
    // Overlapping rules at the same specificity are a misconfiguration the
    // database cannot refuse without btree_gist. Choosing deterministically
    // makes it a *wrong* rate rather than a *varying* one.
    const chosen = selectRule(
      [
        rule({ id: 'OLD', validFrom: new Date('2026-01-01T00:00:00.000Z') }),
        rule({ id: 'NEW', validFrom: new Date('2026-05-01T00:00:00.000Z') }),
      ],
      'ORG-A',
      AT,
    );
    expect(chosen?.id).toBe('NEW');
  });

  it('applies the rate in force when the transaction occurred, not the newest', () => {
    // docs/10 § 10.12's mandatory test. Settling a three-week-old obligation
    // at today's rate would silently reprice work agreed under the old one.
    const occurredAt = new Date('2026-03-01T00:00:00.000Z');
    const chosen = selectRule(
      [
        rule({
          id: 'THEN',
          rateBasisPoints: 100,
          validFrom: new Date('2026-01-01T00:00:00.000Z'),
          validTo: new Date('2026-04-01T00:00:00.000Z'),
        }),
        rule({ id: 'NOW', rateBasisPoints: 500, validFrom: new Date('2026-04-01T00:00:00.000Z') }),
      ],
      'ORG-A',
      occurredAt,
    );

    expect(chosen?.id).toBe('THEN');
    expect(chosen?.rateBasisPoints).toBe(100);
  });
});

describe('computeCommission', () => {
  const input = {
    organizationId: 'ORG-A',
    occurredAt: AT,
    grossAmountMinor: 10_000_000n,
    currency: 'IRR',
  };

  it('charges nothing, and says so, when no rule matches', () => {
    // "بدون نرخ فعال = بدون کارمزد" (docs/10 § 10.7). Not an error, and not a
    // guess — and `matched: false` is what distinguishes "unconfigured" from
    // "configured at zero", which mean opposite things to whoever has to
    // explain why the platform earned nothing.
    expect(computeCommission([], input)).toEqual({
      ruleId: null,
      rateBasisPoints: 0,
      amountMinor: 0n,
      matched: false,
    });
  });

  it('reports matched:true for a rule that is deliberately zero-rated', () => {
    const decision = computeCommission([rule({ rateBasisPoints: 0 })], input);
    expect(decision.amountMinor).toBe(0n);
    expect(decision.matched).toBe(true);
    expect(decision.ruleId).toBe('CMR_1');
  });

  it('computes the worked example from docs/10 § 10.4 exactly', () => {
    // 10,000,000 rial at 200 basis points = 200,000. The figure the
    // architecture document uses throughout.
    const decision = computeCommission([rule({ rateBasisPoints: 200 })], input);
    expect(decision.amountMinor).toBe(200_000n);
  });

  it('treats 250 basis points as exactly 2.5%', () => {
    // The reason rates are integer basis points and not decimal percentages
    // (ADR-022): 0.025 is not representable, 250 is.
    expect(computeCommission([rule({ rateBasisPoints: 250 })], input).amountMinor).toBe(250_000n);
  });

  it('rounds half up, on the exact half', () => {
    // 1 rial at 5 000bp is exactly 0.5 — the boundary that decides whether the
    // rule is half-up or half-down. The platform's rule is half-up, applied
    // through one shared function so this service and analytics cannot
    // disagree by a rial (docs/10 § 10.11).
    const decision = computeCommission([rule({ rateBasisPoints: 5_000 })], {
      ...input,
      grossAmountMinor: 1n,
    });
    expect(decision.amountMinor).toBe(1n);
  });

  it('rounds down just below the half', () => {
    // 4 999bp of 1 rial is 0.4999.
    expect(
      computeCommission([rule({ rateBasisPoints: 4_999 })], { ...input, grossAmountMinor: 1n })
        .amountMinor,
    ).toBe(0n);
  });

  it('rounds a fraction far below the half down to nothing', () => {
    // 50bp of 1 rial is 0.005. A commission smaller than the smallest unit of
    // currency is zero, not one — the alternative would round every trivial
    // transaction up to a rial.
    expect(
      computeCommission([rule({ rateBasisPoints: 50 })], { ...input, grossAmountMinor: 1n })
        .amountMinor,
    ).toBe(0n);
  });

  it('rounds half up on a realistic amount', () => {
    // 12 345 rial at 250bp is 308.625 → 309.
    expect(
      computeCommission([rule({ rateBasisPoints: 250 })], { ...input, grossAmountMinor: 12_345n })
        .amountMinor,
    ).toBe(309n);
  });

  it('never loses precision on an amount beyond Number.MAX_SAFE_INTEGER', () => {
    const decision = computeCommission([rule({ rateBasisPoints: 100 })], {
      ...input,
      grossAmountMinor: 90_071_992_547_409_930n,
    });
    expect(decision.amountMinor).toBe(900_719_925_474_099n);
  });

  it('raises a small commission to the rule floor', () => {
    const decision = computeCommission([rule({ rateBasisPoints: 100, minAmountMinor: 50_000n })], {
      ...input,
      grossAmountMinor: 1_000_000n,
    });
    // 1% of 1,000,000 is 10,000; the floor lifts it to 50,000.
    expect(decision.amountMinor).toBe(50_000n);
  });

  it('caps a large commission at the rule ceiling', () => {
    const decision = computeCommission(
      [rule({ rateBasisPoints: 1000, maxAmountMinor: 100_000n })],
      {
        ...input,
        grossAmountMinor: 10_000_000n,
      },
    );
    // 10% of 10,000,000 is 1,000,000; the ceiling holds it at 100,000.
    expect(decision.amountMinor).toBe(100_000n);
  });

  it('never lets a floor charge more than the transaction is worth', () => {
    // `ck_commission_amounts` refuses `amount > gross`; capping here turns a
    // constraint violation into a sane charge rather than a failed settlement.
    const decision = computeCommission([rule({ rateBasisPoints: 100, minAmountMinor: 500_000n })], {
      ...input,
      grossAmountMinor: 1_000n,
    });
    expect(decision.amountMinor).toBe(1_000n);
  });

  it('carries the rule and rate that produced the charge', () => {
    // So the charge stays explicable after the rule is superseded — the reason
    // `commission` copies the rate onto the row rather than only referencing it.
    const decision = computeCommission([rule({ id: 'CMR_X', rateBasisPoints: 175 })], input);
    expect(decision).toMatchObject({ ruleId: 'CMR_X', rateBasisPoints: 175, matched: true });
  });

  it('never charges more than the gross at the maximum possible rate', () => {
    // 10,000bp is 100%. The constraint refuses anything higher.
    const decision = computeCommission([rule({ rateBasisPoints: 10_000 })], input);
    expect(decision.amountMinor).toBe(input.grossAmountMinor);
  });
});

describe('when nothing matches', () => {
  it('charges nothing rather than picking a rate nobody chose', () => {
    // Zero because unconfigured, which is a different fact from a configured
    // rate of zero — and the one the settlement response reports as
    // `commissionRuleMatched: false` (docs/24 Q-08).
    const decision = computeCommission([], {
      organizationId: 'ORG-A',
      occurredAt: new Date('2026-08-29T10:00:00.000Z'),
      grossAmountMinor: 1_000_000n,
      currency: 'IRR',
    });

    expect(decision.matched).toBe(false);
    expect(decision.amountMinor).toBe(0n);
    expect(decision.ruleId).toBeNull();
  });
});
