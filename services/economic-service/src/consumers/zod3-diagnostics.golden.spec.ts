import { Logger } from '@nestjs/common';
import { DLQ_HEADERS, type EventEnvelope } from '@rasta/contracts';
import { EventConsumer, type ConsumerLogger, type HandlerOutcome } from '@rasta/nest-common';
import { dlqMessagesTotal } from '@rasta/observability';
import type { PrismaService } from '../prisma/prisma.service';
import type { SourceFacts } from '../provenance/source-facts.client';
import type { RewardService } from '../reward/reward.service';
import type { TransactionService } from '../transaction/transaction.service';
import { RewardTriggerConsumer } from './reward-trigger.consumer';
import { SettlementAuthorityConsumer } from './settlement-authority.consumer';
import { StatementSettlementConsumer } from './statement-settlement.consumer';

/**
 * Differential goldens for the dead-letter reason of a KNOWN event whose
 * payload fails its schema (`invalidPayloadError`, 13 consumers; PR #444 r1
 * F1), through three of economic's own consumers inside a real EventConsumer.
 * Each `ZOD3` value was recorded by running this file unchanged on main
 * `745d0434` (zod 3.25.76) (`~/worker2/session/t109/scripts/record.sh`).
 * Inputs: an empty payload, wrong types (no consumed schema here or in any
 * other service uses `currencySchema`: the review's one-value enum met only
 * the translation that took no schema, which is gone — pinned in contracts'
 * `zod-issues.spec.ts` and nest-common's pipe goldens). Beside them, PM addendum D: the refusal touches nothing — no
 * processed marker — and the same event id, corrected, is applied.
 */

interface SentRecord {
  topic: string;
  messages: { value: Buffer | null; headers: Record<string, unknown> }[];
}

class FakeDlqProducer {
  readonly sent: SentRecord[] = [];

  async send(record: SentRecord): Promise<void> {
    this.sent.push(record);
  }
}

function envelope(
  eventName: string,
  payload: Record<string, unknown>,
  producer = 'maintenance-service',
): EventEnvelope {
  return {
    eventId: `01JINVALIDPAYLOAD${eventName.slice(0, 8).padEnd(8, 'X')}`,
    eventName,
    eventVersion: 1,
    occurredAt: '2026-10-03T10:00:00.000Z',
    producer,
    producerVersion: '1.0.0',
    aggregateType: 'MaintenanceRequest',
    aggregateId: 'MNT_1',
    correlationId: 'corr-invalid-payload',
    tenantId: 'ORG_INVALID',
    payload,
  } as EventEnvelope;
}

/** A prisma whose every touch is recorded: a refused event must touch nothing. */
function untouchablePrisma(): { prisma: PrismaService; touched: jest.Mock } {
  const touched = jest.fn();
  const handler: ProxyHandler<object> = {
    get: (_target, property) => {
      if (property === 'then') return undefined;
      touched(String(property));
      return new Proxy(() => undefined, handler);
    },
    apply: () => {
      touched('call');
      return Promise.resolve(null);
    },
  };
  return { prisma: new Proxy({}, handler) as PrismaService, touched };
}

/** Runs `build`'s handler — the consumer's own — inside a real EventConsumer. */
function deliverThrough(
  make: (build: (handler: (e: EventEnvelope) => Promise<HandlerOutcome>) => EventConsumer) => void,
  event: EventEnvelope,
  topic = 'rasta.maintenance.v1',
) {
  let handler!: (e: EventEnvelope) => Promise<HandlerOutcome>;
  make((h) => {
    handler = h;
    return {} as EventConsumer;
  });

  const lines: string[] = [];
  const logger: ConsumerLogger = {
    log: (message) => lines.push(`log ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
  const consumer = new EventConsumer(
    {
      brokers: ['localhost:9092'],
      clientId: 'invalid-payload-spec',
      groupId: 'invalid-payload-spec.group',
      topics: [topic],
      deadLetterTopic: 'rasta.maintenance.v1.dlq',
      maxRetries: 3,
      retryBackoffMs: 0,
    },
    (e) => handler(e),
    logger,
  );
  const dlq = new FakeDlqProducer();
  const internals = consumer as unknown as {
    dlqProducer?: FakeDlqProducer;
    handleMessage(t: string, p: number, v: Buffer, h: undefined, o?: string): Promise<void>;
  };
  internals.dlqProducer = dlq;
  const body = Buffer.from(JSON.stringify(event), 'utf8');
  return {
    deliver: () => internals.handleMessage(topic, 0, body, undefined, '11'),
    dlq,
    lines,
  };
}

/** Recorded under zod 3 on main 745d0434; never written by a test run. */
const ZOD3: Record<string, unknown> = {
  'MAINTENANCE_APPROVED a currency of another type':
    'Handler refused (VALIDATION_FAILED): MAINTENANCE_APPROVED 01JINVALIDPAYLOADMAINTENA payload fails its schema: currency invalid_type',
  'MAINTENANCE_APPROVED an empty payload':
    'Handler refused (VALIDATION_FAILED): MAINTENANCE_APPROVED 01JINVALIDPAYLOADMAINTENA payload fails its schema: requestId invalid_type; assetId invalid_type; organizationId invalid_type; approvedBy invalid_type; approvedAt invalid_type; a…',
  'MAINTENANCE_APPROVED wrong types':
    'Handler refused (VALIDATION_FAILED): MAINTENANCE_APPROVED 01JINVALIDPAYLOADMAINTENA payload fails its schema: approvedBy invalid_type; totalCostMinor invalid_string',
  'STATEMENT_APPROVED an empty payload':
    'Handler refused (VALIDATION_FAILED): STATEMENT_APPROVED 01JINVALIDPAYLOADSTATEMEN payload fails its schema: contractId invalid_type; statementId invalid_type; organizationId invalid_type; contractorOrganizationId invalid_type; approvedA…',
  'STATEMENT_APPROVED wrong types':
    'Handler refused (VALIDATION_FAILED): STATEMENT_APPROVED 01JINVALIDPAYLOADSTATEMEN payload fails its schema: contractId invalid_type; organizationId invalid_type',
  'USAGE_RECORDED an empty payload':
    'Handler refused (VALIDATION_FAILED): USAGE_RECORDED 01JINVALIDPAYLOADUSAGE_RE payload fails its schema: usageRecordId invalid_type; assetId invalid_type; organizationId invalid_type',
  'MAINTENANCE_COMPLETED an empty payload':
    'Handler refused (VALIDATION_FAILED): MAINTENANCE_COMPLETED 01JINVALIDPAYLOADMAINTENA payload fails its schema: requestId invalid_type; assetId invalid_type; organizationId invalid_type',
};

function matchesZod3(name: string, observed: unknown): void {
  expect(observed).toEqual(ZOD3[name]);
}

beforeEach(() => {
  dlqMessagesTotal.reset();
  for (const level of ['warn', 'error', 'log'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  dlqMessagesTotal.reset();
});

/** What the dead letter says, or `not dead-lettered`. */
function deadLetterError(dlq: FakeDlqProducer): string {
  const header = dlq.sent[0]?.messages[0]?.headers[DLQ_HEADERS.error];
  if (header === undefined) return 'not dead-lettered';
  return Buffer.isBuffer(header) ? header.toString('utf8') : String(header);
}

const APPROVED = {
  requestId: 'MNT_1',
  assetId: 'AST_1',
  organizationId: 'ORG_INVALID',
  approvedBy: 'USR_1',
  approvedAt: '2026-10-03T09:00:00.000Z',
  totalCostMinor: '1000',
  currency: 'IRR',
};

const settlementAuthority =
  (prisma: PrismaService) =>
  (build: ConstructorParameters<typeof SettlementAuthorityConsumer>[0]) =>
    new SettlementAuthorityConsumer(build, prisma, {} as TransactionService, {} as SourceFacts);

describe('dead-letter reasons name zod 3’s codes, through the real consumers', () => {
  it.each([
    ['a currency of another type', { ...APPROVED, currency: 7 }],
    ['an empty payload', {}],
    ['wrong types', { ...APPROVED, approvedBy: 42, totalCostMinor: 'x', approvedAt: 'yesterday' }],
  ])('settlement-authority MAINTENANCE_APPROVED: %s', async (name, payload) => {
    const { prisma } = untouchablePrisma();
    const { deliver, dlq } = deliverThrough(
      settlementAuthority(prisma),
      envelope('MAINTENANCE_APPROVED', payload),
    );
    await deliver();
    matchesZod3(`MAINTENANCE_APPROVED ${name}`, deadLetterError(dlq));
  });

  it.each([
    ['an empty payload', {}],
    [
      'wrong types',
      {
        contractId: 7,
        statementId: 'nine',
        organizationId: null,
        contractorOrganizationId: 'ORG_B',
        approvedAt: 'x',
      },
    ],
  ])('statement-settlement STATEMENT_APPROVED: %s', async (name, payload) => {
    const { prisma } = untouchablePrisma();
    const { deliver, dlq } = deliverThrough(
      (build) =>
        new StatementSettlementConsumer(
          build,
          prisma,
          {} as TransactionService,
          {} as SourceFacts,
          null,
        ),
      envelope('STATEMENT_APPROVED', payload, 'contract-service'),
      'rasta.contract.v1',
    );
    await deliver();
    matchesZod3(`STATEMENT_APPROVED ${name}`, deadLetterError(dlq));
  });

  it.each([
    ['USAGE_RECORDED', {}],
    ['MAINTENANCE_COMPLETED', {}],
  ])('reward-trigger %s: an empty payload', async (eventName, payload) => {
    const { prisma } = untouchablePrisma();
    const { deliver, dlq } = deliverThrough(
      (build) => new RewardTriggerConsumer(build, prisma, {} as RewardService, {} as SourceFacts),
      envelope(eventName, payload),
    );
    await deliver();
    matchesZod3(`${eventName} an empty payload`, deadLetterError(dlq));
  });
});

describe('PM addendum D: refused before any write, so a corrected replay is applied', () => {
  it('the malformed event touches nothing; the same id, corrected, reaches the store', async () => {
    const { prisma, touched } = untouchablePrisma();
    const malformed = deliverThrough(
      settlementAuthority(prisma),
      envelope('MAINTENANCE_APPROVED', { ...APPROVED, currency: 7 }),
    );
    await malformed.deliver();
    expect(malformed.dlq.sent).toHaveLength(1);
    // No processed marker, no row: nothing reached the database at all.
    expect(touched).not.toHaveBeenCalled();

    const corrected = deliverThrough(
      settlementAuthority(prisma),
      envelope('MAINTENANCE_APPROVED', APPROVED),
    );
    await corrected.deliver();
    // Same event id (envelope() derives it from the name): validation passed and the
    // handler went on to the database, where a marker would be written.
    expect(touched).toHaveBeenCalled();
  });
});
