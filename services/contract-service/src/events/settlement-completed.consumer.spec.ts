import { DLQ_REASONS } from '@rasta/contracts';
import { EventConsumer, UnprocessableEventError } from '@rasta/nest-common';
import type { ContractRepository } from '../contract/contract.repository';
import type { PrismaService } from '../prisma/prisma.service';
import type { ObligationSource } from '../settlement/obligation-source.client';
import type { SettlementRepository } from '../settlement/settlement.repository';
import type { EventPublisher } from './publisher';
import {
  SETTLEMENT_COMPLETED_CONSUMER,
  SETTLEMENT_COMPLETED_FIELDS,
  SETTLEMENT_COMPLETED_TOPICS,
  SettlementCompletedConsumer,
  settlementCompletedConsumerFactory,
} from './settlement-completed.consumer';

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

/** Every collaborator throws if touched: what a refusal before any read must not reach. */
const untouchable = <T>(name: string): T =>
  new Proxy(
    {},
    {
      get: () => () => {
        throw new Error(`${name} was touched`);
      },
    },
  ) as T;

function consumerWith(
  factory: ConstructorParameters<typeof SettlementCompletedConsumer>[0] = jest.fn(),
) {
  return new SettlementCompletedConsumer(
    factory,
    untouchable<PrismaService>('prisma'),
    untouchable<ContractRepository>('contracts'),
    untouchable<SettlementRepository>('settlements'),
    untouchable<EventPublisher>('publisher'),
    untouchable<ObligationSource>('economic'),
    silent,
  );
}

const payload = {
  settlementId: 'STL_1',
  transactionId: 'TXN_1',
  organizationId: 'ORG_OWNER',
  payerOrganizationId: 'ORG_OWNER',
  payeeOrganizationId: 'ORG_WINNER',
  journalId: 'JNL_1',
  grossAmountMinor: '1500',
  commissionAmountMinor: '15',
  netAmountMinor: '1485',
  currency: 'IRR',
  settledAt: '2026-10-17T10:00:00.000Z',
};
const envelope = (overrides: Record<string, unknown> = {}) =>
  ({
    eventId: 'EVT_1',
    eventName: 'SETTLEMENT_COMPLETED',
    tenantId: 'ORG_OWNER',
    correlationId: 'COR_1',
    payload,
    ...overrides,
  }) as never;

const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UnprocessableEventError);
  return error as UnprocessableEventError;
};

describe('SettlementCompletedConsumer lifecycle', () => {
  it('builds its EventConsumer with its own handler on start, and stops it on stop', async () => {
    const start = jest.fn(async () => undefined);
    const stop = jest.fn(async () => undefined);
    const factory = jest.fn(() => ({ start, stop }) as unknown as EventConsumer);
    const consumer = consumerWith(factory);

    await consumer.start();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);

    await consumer.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('is safe to stop before it was started', async () => {
    await expect(consumerWith().stop()).resolves.toBeUndefined();
  });
});

describe('SettlementCompletedConsumer, before anything is read or asked', () => {
  it.each(['PAYMENT_COMPLETED', 'TRANSACTION_STATUS_CHANGED', 'STATEMENT_APPROVED'])(
    'skips %s: only SETTLEMENT_COMPLETED marks a settlement (PAYMENT_COMPLETED is a top-up)',
    async (eventName) => {
      expect(await consumerWith().handle(envelope({ eventName }))).toBe('SKIPPED');
    },
  );

  it('dead-letters a payload that fails its schema as VALIDATION_FAILED, naming fields and never values', async () => {
    const error = await refusal(
      consumerWith().handle(
        envelope({ payload: { ...payload, grossAmountMinor: 'secret-1.5', transactionId: '' } }),
      ),
    );
    expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
    expect(error.message).toContain('grossAmountMinor');
    expect(error.message).not.toContain('secret');
  });

  it.each([
    ['no tenant', { tenantId: undefined }],
    ['another tenant than the organization', { tenantId: 'ORG_ELSE' }],
    [
      'a payer other than the organization',
      { payload: { ...payload, payerOrganizationId: 'ORG_ELSE' } },
    ],
    [
      'an organization other than the tenant',
      { payload: { ...payload, organizationId: 'ORG_ELSE', payerOrganizationId: 'ORG_ELSE' } },
    ],
  ])(
    'dead-letters %s as SOURCE_UNCONFIRMED (tenant_mismatch) without touching a repository or economic',
    async (_label, overrides) => {
      const error = await refusal(consumerWith().handle(envelope(overrides)));
      expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
      expect(error.message).toContain('tenant_mismatch');
    },
  );
});

describe('settlementCompletedConsumerFactory', () => {
  it('reads the economic topic under its own group, and dead-letters to its own topic', () => {
    expect(SETTLEMENT_COMPLETED_CONSUMER).toBe('contract-service.settlement-completed');
    expect(SETTLEMENT_COMPLETED_TOPICS).toEqual(['rasta.economic.v1']);

    const factory = settlementCompletedConsumerFactory(
      { brokers: ['localhost:19092'], clientId: 'test' },
      { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      { maxRetries: 3, retryBackoffMs: 50 },
    );
    expect(factory(async () => undefined)).toBeInstanceOf(EventConsumer);
  });

  it('names exactly the fields the payload schema declares, for a dead-letter message', () => {
    expect([...SETTLEMENT_COMPLETED_FIELDS].sort()).toEqual(
      [
        'grossAmountMinor',
        'organizationId',
        'payeeOrganizationId',
        'payerOrganizationId',
        'settlementId',
        'transactionId',
      ].sort(),
    );
  });
});
