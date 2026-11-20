import { RastaError } from '@rasta/nest-common';
import { DeductionRuleService } from './deduction-rule.service';
import { DeductionRuleAccess } from './deduction-rule.access';
import { DeductionRuleRepository } from './deduction-rule.repository';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { IdempotencyStore, type ClaimFence } from '../shared/idempotency';
import type { DeductionReceipt } from './dto';

/** Focused command invariant tests; the real rollback and guards are covered by PostgreSQL/API tests. */
describe('deduction proposal service refusals', () => {
  const dto = { kind: 'CREATE' as const, name: 'Tax A', rateBp: 500, base: 'GROSS' as const };
  const actor = { userId: 'USR_1', issuer: 'issuer', subject: 'subject' };

  it('refuses current authority before looking up or claiming an idempotency key', async () => {
    const access = {
      assertWriter: jest.fn(() => {
        throw RastaError.forbidden('Employer writer required');
      }),
    };
    const execute = jest.fn();
    const service = new DeductionRuleService(
      access as unknown as DeductionRuleAccess,
      {} as PrismaService,
      {} as DeductionRuleRepository,
      {} as EventPublisher,
      { execute } as unknown as IdempotencyStore,
    );
    await expect(service.propose(dto, 'valid-key')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses an invalid newly produced receipt before enqueue or fence completion', async () => {
    const hold = jest.fn(),
      complete = jest.fn(),
      enqueue = jest.fn();
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ now: new Date('2026-11-19T09:00:00.000Z') }]),
    } as unknown as ExtendedPrismaClient;
    const transaction = async (
      fn: (client: ExtendedPrismaClient) => Promise<unknown>,
    ): Promise<unknown> => fn(tx);
    const execute = async (
      _endpoint: string,
      _key: string,
      _body: unknown,
      _status: number,
      work: (fence: ClaimFence<DeductionReceipt>) => Promise<unknown>,
    ): Promise<unknown> => work({ hold, complete, firstRefusal: jest.fn() });
    const service = new DeductionRuleService(
      {
        assertWriter: () => ({ organizationId: 'ORG_1', actor }),
      } as unknown as DeductionRuleAccess,
      { transaction } as unknown as PrismaService,
      {
        proposeCreate: jest.fn().mockResolvedValue({
          id: 'DRC_1',
          organizationId: 'ORG_1',
          kind: 'INVALID',
          proposedAt: new Date('2026-11-19T09:00:00.000Z'),
        }),
      } as unknown as DeductionRuleRepository,
      { enqueue } as unknown as EventPublisher,
      { execute } as unknown as IdempotencyStore,
    );
    await expect(service.propose(dto, 'valid-key')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Invalid deduction proposal receipt',
    });
    expect(hold).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
