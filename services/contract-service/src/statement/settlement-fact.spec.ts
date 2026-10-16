import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import type { StatementDecision } from '../generated/prisma';
import type { StatementForSettlement, StatementRepository } from './statement.repository';
import {
  SETTLEMENT_READ_CALLER,
  StatementSettlementService,
  approvedAtOf,
  assertSettlementReadCaller,
  toStatementSettlementView,
} from './settlement-fact';

function as<T>(overrides: Partial<RequestContext>, fn: () => T): T {
  return runWithContext(
    {
      requestId: 'r',
      correlationId: 'c',
      authType: 'SERVICE',
      callerService: SETTLEMENT_READ_CALLER,
      organizationId: 'ORG_EMPLOYER',
      roles: ['SERVICE'],
      startedAt: Date.now(),
      ...overrides,
    } as RequestContext,
    fn,
  );
}

const MAX = 9223372036854775807n; // 2^63 - 1

const decision = (
  chain: 'TECHNICAL' | 'FINANCIAL',
  stepOrder: number,
  decidedAt: string,
  outcome: 'APPROVED' | 'REJECTED' = 'APPROVED',
): StatementDecision =>
  ({ chain, stepOrder, outcome, decidedAt: new Date(decidedAt) }) as StatementDecision;

const row = (overrides: Partial<StatementForSettlement> = {}): StatementForSettlement =>
  ({
    id: 'STM_1',
    organizationId: 'ORG_EMPLOYER',
    contractId: 'CON_1',
    status: 'APPROVED',
    grossMinor: MAX,
    deductionsMinor: 0n,
    netMinor: MAX,
    financialStepCount: 2,
    contract: { contractorOrganizationId: 'ORG_CONTRACTOR' },
    decisions: [
      decision('FINANCIAL', 1, '2026-10-16T10:00:00.000Z'),
      decision('FINANCIAL', 2, '2026-10-16T11:30:00.123Z'),
    ],
    ...overrides,
  }) as StatementForSettlement;

describe('the settlement read of a statement (ADR-068 § 6 (2))', () => {
  describe('who may call it (ADR-061 § 4)', () => {
    it('admits economic-service’s service token', () => {
      expect(() => as({}, assertSettlementReadCaller)).not.toThrow();
    });

    it.each([
      [
        'a user token, whatever its roles',
        { authType: 'USER', callerService: undefined, roles: ['SYSTEM_ADMIN'] },
      ],
      ['a user token relayed by a service', { authType: 'USER', callerService: 'api-gateway' }],
      ['another service', { callerService: 'marketplace-service' }],
      ['a service token naming no caller', { callerService: undefined }],
    ] as [string, Partial<RequestContext>][])('refuses %s with 403', (_, overrides) => {
      const thrown = (() => {
        try {
          as(overrides, assertSettlementReadCaller);
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
    it('states the row: the net as the exact decimal string at 2^63 - 1, rials, the employer pays the contractor, approved when the last financial step approved it', () => {
      expect(toStatementSettlementView(row())).toEqual({
        statementId: 'STM_1',
        contractId: 'CON_1',
        status: 'APPROVED',
        netMinor: '9223372036854775807',
        currency: 'IRR',
        payerOrganizationId: 'ORG_EMPLOYER',
        beneficiaryOrganizationId: 'ORG_CONTRACTOR',
        approvedAt: '2026-10-16T11:30:00.123Z',
      });
    });

    it('is the net, not the gross', () => {
      const view = toStatementSettlementView(
        row({ grossMinor: 1000n, deductionsMinor: 250n, netMinor: 750n }),
      );
      expect(view.netMinor).toBe('750');
    });

    it.each(['DRAFT', 'SUBMITTED', 'TECHNICALLY_APPROVED', 'REJECTED'] as const)(
      'answers a %s statement with its status and no approval instant: the reader refuses it',
      (status) => {
        const view = toStatementSettlementView(row({ status, decisions: [] }));
        expect(view.status).toBe(status);
        expect(view.approvedAt).toBeNull();
      },
    );

    it('takes the approval instant only from the financial chain’s last step, approved', () => {
      // An earlier financial step decided later than the last one is not the approval.
      expect(
        approvedAtOf(
          row({
            decisions: [
              decision('FINANCIAL', 2, '2026-10-16T09:00:00.000Z'),
              decision('FINANCIAL', 1, '2026-10-16T12:00:00.000Z'),
            ],
          }),
        )?.toISOString(),
      ).toBe('2026-10-16T09:00:00.000Z');
    });

    it('never guesses an approval instant for an APPROVED row without its final approval: a defect, thrown', () => {
      expect(() =>
        approvedAtOf(row({ decisions: [decision('FINANCIAL', 1, '2026-10-16T10:00:00.000Z')] })),
      ).toThrow(/no final financial approval/);
      expect(() =>
        approvedAtOf(
          row({
            financialStepCount: 1,
            decisions: [decision('TECHNICAL', 1, '2026-10-16T10:00:00.000Z')],
          }),
        ),
      ).toThrow(/no final financial approval/);
    });
  });

  describe('the service', () => {
    const repository = (found: StatementForSettlement | null) => {
      const findForSettlement = jest.fn().mockResolvedValue(found);
      return {
        findForSettlement,
        service: new StatementSettlementService({
          findForSettlement,
        } as unknown as StatementRepository),
      };
    };

    it('refuses before any query: a user token, and a service token signed for no organization', async () => {
      const { findForSettlement, service } = repository(row());
      await expect(
        as({ authType: 'USER', callerService: undefined }, () => service.statementFact('STM_1')),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // A 403 too (`ERROR_STATUS`), with the platform's code for a tenant-less service token.
      await expect(
        as({ organizationId: undefined }, () => service.statementFact('STM_1')),
      ).rejects.toMatchObject({ code: 'SERVICE_TENANT_CONTEXT_INVALID' });
      expect(findForSettlement).not.toHaveBeenCalled();
    });

    it('answers 404 naming the statement when the tenant-scoped read finds nothing', async () => {
      const { findForSettlement, service } = repository(null);
      await expect(as({}, () => service.statementFact('STM_X'))).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Statement not found',
      });
      expect(findForSettlement).toHaveBeenCalledWith('STM_X');
    });
  });
});
