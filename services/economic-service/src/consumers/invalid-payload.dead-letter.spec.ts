import { Logger } from '@nestjs/common';
import { DLQ_HEADERS, DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { EventConsumer, type ConsumerLogger, type HandlerOutcome } from '@rasta/nest-common';
import { dlqMessagesTotal } from '@rasta/observability';
import type { PrismaService } from '../prisma/prisma.service';
import type { SourceFacts } from '../provenance/source-facts.client';
import type { RewardService } from '../reward/reward.service';
import type { TransactionService } from '../transaction/transaction.service';
import { RewardTriggerConsumer } from './reward-trigger.consumer';
import { SettlementAuthorityConsumer } from './settlement-authority.consumer';

/**
 * L7-26 and S-09 for economic-service's two consumers, through the REAL
 * `EventConsumer`: a KNOWN event whose payload fails its schema is
 * dead-lettered at once as `VALIDATION_FAILED` — not retried three times and
 * then filed as `MAX_RETRIES_EXCEEDED` with zod's own text, which can quote
 * the value received — and nothing is marked processed, so a corrected replay
 * with the same id still applies.
 *
 * The sentinel sits in a failing field: it must reach neither `x-dlq-error`
 * nor any log line.
 */

const SENTINEL = 'SENTINEL-4d2a-payload-value';

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

function envelope(eventName: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    eventId: `01JINVALIDPAYLOAD${eventName.slice(0, 8).padEnd(8, 'X')}`,
    eventName,
    eventVersion: 1,
    occurredAt: '2026-10-03T10:00:00.000Z',
    producer: 'maintenance-service',
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
      topics: ['rasta.maintenance.v1'],
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
    deliver: () => internals.handleMessage('rasta.maintenance.v1', 0, body, undefined, '11'),
    dlq,
    lines,
  };
}

let nestLines: string[];

beforeEach(() => {
  dlqMessagesTotal.reset();
  nestLines = [];
  for (const level of ['warn', 'error', 'log'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      nestLines.push(String(args[0]));
    });
  }
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  dlqMessagesTotal.reset();
});

function expectDeadLetteredAtOnce(
  dlq: FakeDlqProducer,
  lines: string[],
  expectedIssues: string,
): void {
  // No retry attempts: a producer defect is not retried.
  expect(lines.filter((line) => line.startsWith('warn Attempt'))).toHaveLength(0);
  expect(dlq.sent).toHaveLength(1);
  const headers = dlq.sent[0]?.messages[0]?.headers ?? {};
  expect(headers[DLQ_HEADERS.reason]).toBe(DLQ_REASONS.VALIDATION_FAILED);
  expect(String(headers[DLQ_HEADERS.error])).toContain(
    `payload fails its schema: ${expectedIssues}`,
  );
  const written = [
    ...lines,
    ...nestLines,
    ...Object.values(headers).map((value) =>
      Buffer.isBuffer(value) ? value.toString('utf8') : String(value),
    ),
  ].join('\n');
  expect(written).not.toContain('SENTINEL');
}

describe('a known event with a malformed payload, through the real EventConsumer (L7-26, S-09)', () => {
  it('settlement-authority: MAINTENANCE_APPROVED is dead-lettered at once; nothing is touched', async () => {
    const { prisma, touched } = untouchablePrisma();
    const { deliver, dlq, lines } = deliverThrough(
      (build) =>
        new SettlementAuthorityConsumer(build, prisma, {} as TransactionService, {} as SourceFacts),
      envelope('MAINTENANCE_APPROVED', {
        requestId: 'MNT_1',
        assetId: 'AST_1',
        organizationId: 'ORG_INVALID',
        approvedBy: 42,
        approvedAt: '2026-10-03T09:00:00.000Z',
        totalCostMinor: SENTINEL,
        currency: 'IRR',
      }),
    );

    await deliver();

    expectDeadLetteredAtOnce(dlq, lines, 'approvedBy invalid_type; totalCostMinor invalid_string');
    expect(touched).not.toHaveBeenCalled();
  });

  it.each([
    [
      'USAGE_RECORDED',
      { usageRecordId: 'USG_1', organizationId: 'ORG_INVALID', assetId: 7, hours: SENTINEL },
      'assetId invalid_type',
    ],
    [
      'MAINTENANCE_COMPLETED',
      { requestId: 'MNT_1', organizationId: 'ORG_INVALID', downtimeMinutes: SENTINEL },
      'assetId invalid_type; downtimeMinutes invalid_type',
    ],
  ])(
    'reward-trigger: %s is dead-lettered at once; nothing is touched',
    async (eventName, payload, issues) => {
      const { prisma, touched } = untouchablePrisma();
      const { deliver, dlq, lines } = deliverThrough(
        (build) => new RewardTriggerConsumer(build, prisma, {} as RewardService, {} as SourceFacts),
        envelope(eventName, payload),
      );

      await deliver();

      expectDeadLetteredAtOnce(dlq, lines, issues);
      expect(touched).not.toHaveBeenCalled();
    },
  );
});
