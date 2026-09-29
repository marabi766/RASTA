import { Logger } from '@nestjs/common';
import { DLQ_HEADERS, DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  EventConsumer,
  RastaError,
  createSystemContext,
  type ConsumerLogger,
} from '@rasta/nest-common';
import { dlqMessagesTotal } from '@rasta/observability';
import type { PrismaService } from '../prisma/prisma.service';
import type { SourceFacts } from '../provenance/source-facts.client';
import { RewardGrantError, type RewardService } from '../reward/reward.service';
import { RewardTriggerConsumer } from './reward-trigger.consumer';

/**
 * S-09 through the REAL `EventConsumer` (review of #136, finding 1): a grant
 * failure's underlying message — here a sentinel standing in for tenant data
 * — reaches neither the consumer's retry and give-up lines nor `x-dlq-error`.
 *
 * The transient path matters most: the reward consumer rethrows the
 * `RewardGrantError` whole, so the consumer repeats that error's message on
 * every attempt. The message is now rule ids and error codes; the underlying
 * errors stay in its typed `failures` field, which nothing logs.
 */

const SENTINEL = 'SENTINEL-6e1c-beneficiary-name-Zahra';

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

interface GrantHandle {
  grant(
    envelope: EventEnvelope,
    claim: { organizationId: string; assetId: string; sourceReference: string },
    context: ReturnType<typeof createSystemContext>,
    input: unknown,
  ): Promise<unknown>;
}

const ENVELOPE = {
  eventId: '01JREWARDDLQSPEC000000001',
  eventName: 'ASSET_DECOMMISSIONED',
  eventVersion: 1,
  occurredAt: '2026-09-29T10:00:00.000Z',
  producer: 'asset-service',
  producerVersion: '1.0.0',
  aggregateType: 'Asset',
  aggregateId: 'AST_REWARD_DLQ_1',
  correlationId: 'corr-reward-dlq',
  tenantId: 'ORG_REWARD_DLQ',
  payload: {},
};
const CLAIM = { organizationId: 'ORG_REWARD_DLQ', assetId: 'AST_1', sourceReference: 'USG_1' };

/** The reward consumer's grant step, failing with `error`, run by a real EventConsumer. */
function consumerOver(error: unknown): {
  deliver: () => Promise<void>;
  dlq: FakeDlqProducer;
  lines: string[];
} {
  const rewards = { grantFor: jest.fn().mockRejectedValue(error) } as unknown as RewardService;
  const reward = new RewardTriggerConsumer(
    () => ({}) as EventConsumer,
    {} as PrismaService,
    rewards,
    {} as SourceFacts,
  ) as unknown as GrantHandle;

  const lines: string[] = [];
  const logger: ConsumerLogger = {
    log: (message) => lines.push(`log ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
  const consumer = new EventConsumer(
    {
      brokers: ['localhost:9092'],
      clientId: 'reward-trigger-dlq-spec',
      groupId: 'reward-trigger-dlq-spec.group',
      topics: ['rasta.asset.v1'],
      deadLetterTopic: 'rasta.asset.v1.dlq',
      maxRetries: 3,
      retryBackoffMs: 0,
    },
    async (envelope) => {
      await reward.grant(envelope, CLAIM, createSystemContext({ correlationId: 'c' }), {});
    },
    logger,
  );
  const dlq = new FakeDlqProducer();
  const handle = consumer as unknown as {
    dlqProducer?: FakeDlqProducer;
    handleMessage(t: string, p: number, v: Buffer, h: undefined, o?: string): Promise<void>;
  };
  handle.dlqProducer = dlq;
  const body = Buffer.from(JSON.stringify(ENVELOPE), 'utf8');
  return {
    deliver: () => handle.handleMessage('rasta.asset.v1', 0, body, undefined, '7'),
    dlq,
    lines,
  };
}

let nestWarnings: string[];

beforeEach(() => {
  dlqMessagesTotal.reset();
  nestWarnings = [];
  jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
    nestWarnings.push(String(message));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  dlqMessagesTotal.reset();
});

function everythingWritten(dlq: FakeDlqProducer, lines: string[]): string {
  const headers = dlq.sent
    .flatMap((record) => record.messages)
    .flatMap((message) => Object.values(message.headers))
    .map((value) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value)));
  return [...lines, ...nestWarnings, ...headers].join('\n');
}

describe('reward grant failures through the real EventConsumer (S-09)', () => {
  it('a transient failure: every retry line and the dead letter carry rule ids and codes only', async () => {
    const blip = new RewardGrantError(
      [],
      [{ ruleId: 'RWR_A', error: new Error(`credit for ${SENTINEL} timed out`) }],
    );
    // The control: the sentinel is there to leak, in the typed field.
    expect(String(blip.failures[0]?.error)).toContain(SENTINEL);

    const { deliver, dlq, lines } = consumerOver(blip);
    await deliver();

    expect(lines.filter((line) => line.startsWith('warn Attempt'))).toHaveLength(2);
    expect(dlq.sent).toHaveLength(1);
    const headers = dlq.sent[0]?.messages[0]?.headers ?? {};
    expect(headers[DLQ_HEADERS.reason]).toBe(DLQ_REASONS.MAX_RETRIES_EXCEEDED);
    expect(String(headers[DLQ_HEADERS.error])).toBe(
      'Handler failed 3x (MAX_RETRIES_EXCEEDED): RewardGrantError: 1 reward rule(s) failed to grant: RWR_A (Error)',
    );
    expect(everythingWritten(dlq, lines)).not.toContain('SENTINEL');
  });

  it('a permanent refusal: dead-lettered at once, codes only', async () => {
    const refused = new RewardGrantError(
      [],
      [{ ruleId: 'RWR_B', error: RastaError.businessRule(`no reward for ${SENTINEL}`) }],
    );

    const { deliver, dlq, lines } = consumerOver(refused);
    await deliver();

    const headers = dlq.sent[0]?.messages[0]?.headers ?? {};
    expect(headers[DLQ_HEADERS.reason]).toBe(DLQ_REASONS.BUSINESS_RULE_VIOLATION);
    expect(String(headers[DLQ_HEADERS.error])).toMatch(/fixed: RWR_B \(BUSINESS_RULE_VIOLATION\)$/);
    expect(everythingWritten(dlq, lines)).not.toContain('SENTINEL');
  });
});
