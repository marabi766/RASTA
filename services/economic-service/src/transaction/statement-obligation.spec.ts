import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import type { TransactionRepository } from './transaction.repository';
import {
  STATEMENT_OBLIGATION_READ_CALLER,
  StatementObligationService,
  assertStatementObligationReadCaller,
  fullySettledOf,
  toStatementObligationView,
  type StatementObligationRow,
} from './statement-obligation';

function as<T>(overrides: Partial<RequestContext>, fn: () => T): T {
  return runWithContext(
    {
      requestId: 'r',
      correlationId: 'c',
      authType: 'SERVICE',
      callerService: STATEMENT_OBLIGATION_READ_CALLER,
      organizationId: 'ORG_EMPLOYER',
      roles: ['SERVICE'],
      startedAt: Date.now(),
      ...overrides,
    } as RequestContext,
    fn,
  );
}

const MAX = 9223372036854775807n; // 2^63 - 1

const row = (overrides: Partial<StatementObligationRow> = {}): StatementObligationRow => ({
  id: 'TXN_1',
  organizationId: 'ORG_EMPLOYER',
  counterpartyOrganizationId: 'ORG_CONTRACTOR',
  status: 'PENDING_SETTLEMENT',
  grossAmountMinor: MAX,
  currency: 'IRR',
  sourceReference: 'STM_1',
  settlement: null,
  ...overrides,
});

const settledRow = (overrides: Partial<StatementObligationRow> = {}) =>
  row({
    status: 'SETTLED',
    settlement: {
      id: 'STL_1',
      grossAmountMinor: MAX,
      settledAt: new Date('2026-10-17T09:15:00.123Z'),
    },
    ...overrides,
  });

describe('the read of a statement’s obligation (ADR-068 § 6 (3))', () => {
  describe('who may call it (ADR-061 § 4)', () => {
    it('admits contract-service’s service token', () => {
      expect(() => as({}, assertStatementObligationReadCaller)).not.toThrow();
    });

    it.each([
      [
        'a user token, whatever its roles',
        { authType: 'USER', callerService: undefined, roles: ['SYSTEM_ADMIN'] },
      ],
      ['a user token relayed by a service', { authType: 'USER', callerService: 'api-gateway' }],
      ['another service', { callerService: 'marketplace-service' }],
      ['economic-service itself', { callerService: 'economic-service' }],
      ['a service token naming no caller', { callerService: undefined }],
    ] as [string, Partial<RequestContext>][])('refuses %s with 403', (_, overrides) => {
      const thrown = (() => {
        try {
          as(overrides, assertStatementObligationReadCaller);
        } catch (error) {
          return error;
        }
        return undefined;
      })();
      expect(thrown).toBeInstanceOf(RastaError);
      expect((thrown as RastaError).code).toBe('FORBIDDEN');
    });
  });

  describe('the answer', () => {
    it('states an unsettled obligation: the whole amount as the exact decimal string at 2^63 - 1, nothing settled', () => {
      expect(toStatementObligationView(row())).toEqual({
        obligationId: 'TXN_1',
        statementId: 'STM_1',
        status: 'PENDING_SETTLEMENT',
        amountMinor: '9223372036854775807',
        currency: 'IRR',
        payerOrganizationId: 'ORG_EMPLOYER',
        beneficiaryOrganizationId: 'ORG_CONTRACTOR',
        settlementId: null,
        settledAt: null,
        settledAmountMinor: null,
        fullySettled: false,
      });
    });

    it('states a settled one: its settlement, when, the amount it took, and fully settled', () => {
      expect(toStatementObligationView(settledRow())).toMatchObject({
        status: 'SETTLED',
        amountMinor: '9223372036854775807',
        settlementId: 'STL_1',
        settledAt: '2026-10-17T09:15:00.123Z',
        settledAmountMinor: '9223372036854775807',
        fullySettled: true,
      });
    });

    it.each([
      'CREATED',
      'HELD',
      'PENDING_SETTLEMENT',
      'DISPUTED',
      'REFUNDED',
      'CANCELLED',
      'FAILED',
    ])(
      'answers %s without a settlement as not settled: the reader does not mark the statement SETTLED',
      (status) => {
        const view = toStatementObligationView(row({ status }));
        expect(view.status).toBe(status);
        expect(view.fullySettled).toBe(false);
        expect(view.settledAt).toBeNull();
      },
    );

    it('never guesses: SETTLED without a settlement, or with a settlement of another amount, is a defect, thrown', () => {
      expect(() => fullySettledOf(row({ status: 'SETTLED' }))).toThrow(
        /no settlement of its whole amount/,
      );
      expect(() =>
        fullySettledOf(
          settledRow({
            settlement: { id: 'STL_1', grossAmountMinor: MAX - 1n, settledAt: new Date() },
          }),
        ),
      ).toThrow(/no settlement of its whole amount/);
    });

    it('never guesses: a settlement under any status but SETTLED is a defect, thrown', () => {
      expect(() => fullySettledOf(settledRow({ status: 'DISPUTED' }))).toThrow(
        /has a settlement but is DISPUTED/,
      );
    });

    it('refuses a row that names no beneficiary or no statement: a defect, thrown', () => {
      expect(() => toStatementObligationView(row({ counterpartyOrganizationId: null }))).toThrow(
        /names no beneficiary or no statement/,
      );
      expect(() => toStatementObligationView(row({ sourceReference: null }))).toThrow(
        /names no beneficiary or no statement/,
      );
    });
  });

  describe('the service', () => {
    const repository = (found: StatementObligationRow | null) => {
      const findStatementObligation = jest.fn().mockResolvedValue(found);
      return {
        findStatementObligation,
        service: new StatementObligationService({
          findStatementObligation,
        } as unknown as TransactionRepository),
      };
    };

    it('reads as the payer signed into the token, by the statement id', async () => {
      const { findStatementObligation, service } = repository(row());
      await expect(as({}, () => service.statementObligation('STM_1'))).resolves.toMatchObject({
        obligationId: 'TXN_1',
      });
      expect(findStatementObligation).toHaveBeenCalledWith('ORG_EMPLOYER', 'STM_1');
    });

    it('refuses before any query: a user token, and a service token signed for no organization', async () => {
      const { findStatementObligation, service } = repository(row());
      await expect(
        as({ authType: 'USER', callerService: undefined }, () =>
          service.statementObligation('STM_1'),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // A 403 too (`ERROR_STATUS`), with the platform's code for a tenant-less service token.
      await expect(
        as({ organizationId: undefined }, () => service.statementObligation('STM_1')),
      ).rejects.toMatchObject({ code: 'SERVICE_TENANT_CONTEXT_INVALID' });
      expect(findStatementObligation).not.toHaveBeenCalled();
    });

    it('answers 404 with fixed words when the payer’s read finds nothing', async () => {
      const { service } = repository(null);
      await expect(as({}, () => service.statementObligation('STM_X'))).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Obligation not found',
      });
    });
  });
});
