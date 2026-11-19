import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { EventPublisher } from './publisher';
import type { ContractEnv } from '../config/env';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';

/** A focused invariant test, not a PostgreSQL/Kafka integration test. */
describe('proposal publisher validates the actual envelope before persistence', () => {
  const at = new Date('2026-11-19T09:00:00.000Z');
  const payload = {
    changeId: 'DRC_1',
    organizationId: 'ORG_1',
    kind: 'CREATE',
    proposedAt: at.toISOString(),
    proposedBy: 'USR_1',
    version: 1,
  };
  const context: RequestContext = {
    requestId: 'request-1',
    startedAt: 0,
    correlationId: 'corr-1',
    userId: 'USR_1',
    authType: 'USER',
    roles: ['ORGANIZATION_ADMIN'],
    organizationIds: ['ORG_1'],
    organizationId: 'ORG_1',
    issuer: 'issuer',
    subject: 'subject',
    platformUserId: true,
  };
  const publisher = new EventPublisher({ SERVICE_VERSION: '0.1.0' } as ContractEnv);
  const input = {
    eventName: 'DEDUCTION_RULE_CHANGE_PROPOSED' as const,
    aggregateId: 'DRC_1',
    organizationId: 'ORG_1',
    occurredAt: at,
    payload,
  };

  it.each([
    ['tenant mismatch', { ...input, organizationId: 'ORG_other' }, context],
    ['aggregate mismatch', { ...input, aggregateId: 'DRC_other' }, context],
    ['actor mismatch', input, { ...context, userId: 'USR_other' }],
    ['time mismatch', { ...input, occurredAt: new Date('2026-11-19T10:00:00.000Z') }, context],
    ['invalid actual envelope correlation', input, { ...context, correlationId: '' }],
  ] as const)(
    'refuses %s with no outbox insert and a constant safe error',
    async (_label, event, ctx) => {
      const create = jest.fn();
      const tx = {
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ allocated: 1n }]),
        outboxMessage: { create },
      } as unknown as ExtendedPrismaClient;
      await expect(runWithContext(ctx, () => publisher.enqueue(tx, event))).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'Invalid deduction proposal event',
      });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('inserts the envelope that passed runtime parsing, with the same tenant/actor/aggregate/stream', async () => {
    const create = jest.fn().mockResolvedValue({});
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allocated: 1n }]),
      outboxMessage: { create },
    } as unknown as ExtendedPrismaClient;
    await runWithContext(context, () => publisher.enqueue(tx, input));
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      data: {
        aggregateType: 'DeductionRuleChange',
        aggregateId: 'DRC_1',
        organizationId: 'ORG_1',
        partitionKey: 'DRC_1',
        payload: {
          tenantId: 'ORG_1',
          actor: { type: 'USER', id: 'USR_1' },
          aggregateId: 'DRC_1',
          streamKey: 'DRC_1',
          payload,
        },
      },
    });
  });
});
