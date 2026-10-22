import {
  confirmSettlement,
  confirmSettlementTenant,
  contractSettlementDue,
  isObligationOf,
  minorOf,
  type ObligationFact,
  type SettlingStatement,
} from './obligation-confirm';

const MAX = 9_223_372_036_854_775_807n;

const statement: SettlingStatement = {
  id: 'STM_1',
  organizationId: 'ORG_OWNER',
  contractorOrganizationId: 'ORG_WINNER',
  netMinor: 1_500_000_001n,
};
const claim = { transactionId: 'TXN_1', settlementId: 'STL_1' };
const fact: ObligationFact = {
  obligationId: 'TXN_1',
  statementId: 'STM_1',
  status: 'SETTLED',
  amountMinor: '1500000001',
  currency: 'IRR',
  payerOrganizationId: 'ORG_OWNER',
  beneficiaryOrganizationId: 'ORG_WINNER',
  settlementId: 'STL_1',
  settledAt: '2026-10-17T10:00:00.000Z',
  settledAmountMinor: '1500000001',
  fullySettled: true,
};

describe('confirmSettlementTenant (ADR-061 § 5)', () => {
  it('passes only when the envelope’s tenant, the organization and the payer are one', () => {
    expect(confirmSettlementTenant('ORG_A', 'ORG_A', 'ORG_A')).toBe(true);
    expect(confirmSettlementTenant(undefined, 'ORG_A', 'ORG_A')).toBe(false);
    expect(confirmSettlementTenant('', 'ORG_A', 'ORG_A')).toBe(false);
    expect(confirmSettlementTenant('ORG_B', 'ORG_A', 'ORG_A')).toBe(false);
    expect(confirmSettlementTenant('ORG_A', 'ORG_B', 'ORG_A')).toBe(false);
    expect(confirmSettlementTenant('ORG_A', 'ORG_A', 'ORG_B')).toBe(false);
  });
});

describe('isObligationOf', () => {
  it('is the event’s obligation only when economic names the event’s transaction', () => {
    expect(isObligationOf(claim, fact)).toBe(true);
    expect(isObligationOf(claim, { ...fact, obligationId: 'TXN_2' })).toBe(false);
    expect(isObligationOf(claim, null)).toBe(false);
  });
});

describe('minorOf', () => {
  it('reads a bigint’s decimal string exactly, and nothing a column cannot hold', () => {
    expect(minorOf('0')).toBe(0n);
    expect(minorOf(MAX.toString())).toBe(MAX);
    expect(minorOf('9223372036854775808')).toBeNull();
    expect(minorOf('-1')).toBeNull();
    expect(minorOf('1.5')).toBeNull();
    expect(minorOf('')).toBeNull();
    expect(minorOf(null)).toBeNull();
  });
});

describe('confirmSettlement: economic’s answer, held against the statement’s own row (I5)', () => {
  it('confirms a statement settled in full by the settlement the event names, with economic’s figures', () => {
    expect(confirmSettlement(statement, claim, fact)).toEqual({
      confirmed: true,
      settlement: {
        obligationId: 'TXN_1',
        settlementId: 'STL_1',
        settledAt: new Date('2026-10-17T10:00:00.000Z'),
        settledAmountMinor: 1_500_000_001n,
      },
    });
  });

  it('is exact at 2^63 - 1', () => {
    const verdict = confirmSettlement({ ...statement, netMinor: MAX }, claim, {
      ...fact,
      amountMinor: MAX.toString(),
      settledAmountMinor: MAX.toString(),
    });
    expect(verdict).toMatchObject({ confirmed: true, settlement: { settledAmountMinor: MAX } });
  });

  it.each([
    ['another statement', { statementId: 'STM_2' }, 'statement_mismatch'],
    ['another payer', { payerOrganizationId: 'ORG_ELSE' }, 'payer_mismatch'],
    ['another beneficiary', { beneficiaryOrganizationId: 'ORG_ELSE' }, 'beneficiary_mismatch'],
    ['another currency', { currency: 'USD' }, 'currency_mismatch'],
    ['an obligation of one minor unit less', { amountMinor: '1500000000' }, 'amount_mismatch'],
    ['an obligation of one minor unit more', { amountMinor: '1500000002' }, 'amount_mismatch'],
    ['an amount no column holds', { amountMinor: '9223372036854775808' }, 'amount_mismatch'],
    [
      'a settlement of less than the whole',
      { settledAmountMinor: '1500000000' },
      'amount_mismatch',
    ],
    ['a status that is not SETTLED', { status: 'PENDING_SETTLEMENT' }, 'not_settled'],
    ['DISPUTED', { status: 'DISPUTED', fullySettled: false }, 'not_settled'],
    ['fullySettled false', { fullySettled: false }, 'not_settled'],
    ['no settlement', { settlementId: null }, 'not_settled'],
    ['no settlement instant', { settledAt: null }, 'not_settled'],
    ['another settlement than the event’s', { settlementId: 'STL_2' }, 'settlement_mismatch'],
  ] as const)('refuses %s', (_label, change, mismatch) => {
    expect(confirmSettlement(statement, claim, { ...fact, ...change })).toEqual({
      confirmed: false,
      mismatch,
    });
  });

  it('takes nothing from the event but which settlement it claims', () => {
    expect(confirmSettlement(statement, { ...claim, settlementId: 'STL_2' }, fact)).toMatchObject({
      confirmed: false,
      mismatch: 'settlement_mismatch',
    });
  });
});

describe('contractSettlementDue (ADR-068 § 6 (3))', () => {
  const totals = { open: 0, approvedNetMinor: 300n, settledMinor: 300n };

  it('is due for a COMPLETED contract with no statement open and every approved net settled', () => {
    expect(contractSettlementDue('COMPLETED', totals)).toBe(true);
    // A contract with no approved statement settles nothing it owes: 0 = 0.
    expect(
      contractSettlementDue('COMPLETED', { open: 0, approvedNetMinor: 0n, settledMinor: 0n }),
    ).toBe(true);
  });

  it.each(['DRAFT', 'SIGNED', 'SETTLED', 'CANCELLED'])(
    'is never due for a %s contract',
    (status) => {
      expect(contractSettlementDue(status, totals)).toBe(false);
    },
  );

  it('is not due while a statement is open, or while the sums differ by a minor unit', () => {
    expect(contractSettlementDue('COMPLETED', { ...totals, open: 1 })).toBe(false);
    expect(contractSettlementDue('COMPLETED', { ...totals, settledMinor: 299n })).toBe(false);
    expect(contractSettlementDue('COMPLETED', { ...totals, settledMinor: 301n })).toBe(false);
  });
});
