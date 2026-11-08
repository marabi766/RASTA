import { runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { newPrisma } from './helpers';

it('tenant reassignment refusal rolls back ledger, parent, outbox and consumed key in the interactive transaction', async () => {
  const prisma = newPrisma();
  await prisma.onModuleInit();
  const tag = ulid();
  const organizationId = `ORG-WRITE-${tag}`;
  const journalId = `JRN-${tag}`;
  const accountId = `ACC-${tag}`;
  const eventId = `EVT-${tag}`;
  const key = `KEY-${tag}`;
  const context = {
    organizationId,
    correlationId: tag,
    requestId: tag,
    roles: ['SYSTEM_ADMIN'],
    organizationIds: [],
    authType: 'USER' as const,
    startedAt: 0,
  };
  try {
    await expect(
      runWithContext(context, () =>
        prisma.transaction(async (tx) => {
          await tx.ledgerAccount.create({
            data: {
              id: accountId,
              organizationId,
              accountCode: 'regression',
              accountType: 'ASSET',
              purpose: 'PAYMENT_CLEARING',
              createdBy: 'test',
            },
          });
          await tx.journal.create({
            data: {
              id: journalId,
              organizationId,
              journalType: 'WALLET_TOP_UP',
              description: 'Atomic refusal regression',
              postedAt: new Date(),
              postedBy: 'test',
              correlationId: tag,
            },
          });
          await tx.ledgerEntry.createMany({
            data: ['DEBIT', 'CREDIT'].map((direction) => ({
              id: `${direction}-${tag}`,
              journalId,
              accountId,
              organizationId,
              direction: direction as 'DEBIT' | 'CREDIT',
              amountMinor: 1n,
              currency: 'IRR',
              postedAt: new Date(),
            })),
          });
          await tx.outboxMessage.create({
            data: {
              id: eventId,
              aggregateType: 'Journal',
              aggregateId: journalId,
              eventName: 'REGRESSION',
              topic: 'regression',
              partitionKey: journalId,
              payload: {},
              headers: {},
              organizationId,
              correlationId: tag,
            },
          });
          await tx.idempotencyKey.create({
            data: {
              key,
              organizationId,
              endpoint: 'regression',
              requestHash: 'hash',
              state: 'COMPLETED',
              responseStatus: 200,
              responseBody: {},
              expiresAt: new Date(Date.now() + 60_000),
            },
          });
          await tx.ledgerAccount.update({
            where: { id: accountId },
            data: { organizationId: 'foreign-tenant' },
          });
        }),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    await runWithContext(context, async () => {
      expect(await prisma.client.ledgerAccount.count({ where: { id: accountId } })).toBe(0);
      expect(await prisma.client.journal.count({ where: { id: journalId } })).toBe(0);
      expect(await prisma.client.ledgerEntry.count({ where: { journalId } })).toBe(0);
      expect(await prisma.client.outboxMessage.count({ where: { id: eventId } })).toBe(0);
      expect(await prisma.client.idempotencyKey.count({ where: { key } })).toBe(0);
    });
  } finally {
    await prisma.onModuleDestroy();
  }
});
