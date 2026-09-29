import { Logger } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import {
  RastaError,
  UnprocessableEventError,
  createSystemContext,
  type EventConsumer,
} from '@rasta/nest-common';
import type { PrismaService } from '../prisma/prisma.service';
import { RewardGrantError, grantFailureCodes, type RewardService } from '../reward/reward.service';
import type { SourceFacts } from '../provenance/source-facts.client';
import { RewardTriggerConsumer } from './reward-trigger.consumer';

/**
 * S-09: a failed reward grant is reported by rule id and error code only. The
 * underlying message — a downstream's, a driver's, a rule's — reaches neither
 * the dead-letter refusal (`x-dlq-error`) nor the redelivery warning.
 */

const SENTINEL = 'SENTINEL-4d9a-beneficiary-name';

interface GrantHandle {
  grant(
    envelope: EventEnvelope,
    claim: { organizationId: string; assetId: string; sourceReference: string },
    context: ReturnType<typeof createSystemContext>,
    input: unknown,
  ): Promise<unknown>;
}

function consumerFailingWith(error: unknown): GrantHandle {
  const rewards = {
    grantFor: jest.fn().mockRejectedValue(error),
  } as unknown as RewardService;
  const consumer = new RewardTriggerConsumer(
    () => ({}) as EventConsumer,
    {} as PrismaService,
    rewards,
    {} as SourceFacts,
  );
  return consumer as unknown as GrantHandle;
}

const ENVELOPE = {
  eventId: '01JREWARDREFUSALSPEC00001',
  eventName: 'USAGE_RECORDED',
} as EventEnvelope;
const CLAIM = { organizationId: 'ORG_1', assetId: 'AST_1', sourceReference: 'USG_01JREFUSAL' };

async function failure(error: unknown): Promise<unknown> {
  return consumerFailingWith(error)
    .grant(ENVELOPE, CLAIM, createSystemContext({ correlationId: 'corr-refusal' }), {})
    .then(
      () => null,
      (thrown: unknown) => thrown,
    );
}

describe('reward grant refusal (S-09)', () => {
  let warnings: string[];
  beforeEach(() => {
    warnings = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('dead-letters with rule ids and codes, never the rules’ messages', async () => {
    const refused = new RewardGrantError(
      [],
      [
        {
          ruleId: 'RWR_A',
          error: RastaError.businessRule(`credit for ${SENTINEL} must be positive`),
        },
        { ruleId: 'RWR_B', error: RastaError.ledgerUnbalanced('JNL_1', SENTINEL) },
      ],
    );
    // The control: the underlying errors carry the sentinel, in the typed
    // field nothing logs — not in the grant error's own message.
    expect(String(refused.failures[0]?.error)).toContain(SENTINEL);
    expect(refused.message).not.toContain(SENTINEL);

    const thrown = await failure(refused);

    expect(thrown).toBeInstanceOf(UnprocessableEventError);
    expect((thrown as Error).message).toBe(
      'A reward rule refused USAGE_RECORDED USG_01JREFUSAL; replay once the rule is fixed: ' +
        'RWR_A (BUSINESS_RULE_VIOLATION); RWR_B (LEDGER_UNBALANCED)',
    );
  });

  it('a bare platform verdict: its code alone', async () => {
    const thrown = await failure(RastaError.businessRule(`refused ${SENTINEL}`));
    expect((thrown as Error).message).toMatch(/fixed: BUSINESS_RULE_VIOLATION$/);
    expect((thrown as Error).message).not.toContain('SENTINEL');
  });

  it('a transient failure: rethrown whole, and the warning names codes only', async () => {
    const blip = new RewardGrantError(
      [],
      [{ ruleId: 'RWR_A', error: new Error(`connection to ${SENTINEL} reset`) }],
    );

    const thrown = await failure(blip);

    expect(thrown).toBe(blip); // EventConsumer retries it and logs it sanitised
    expect(warnings).toEqual([
      'Reward grant failed for USAGE_RECORDED 01JREWARDREFUSALSPEC00001; ' +
        'left unprocessed for redelivery: RWR_A (Error)',
    ]);
  });
});

describe('grantFailureCodes', () => {
  it('bounds the rules it names', () => {
    const failures = Array.from({ length: 8 }, (_, i) => ({
      ruleId: `RWR_${i}`,
      error: RastaError.businessRule(SENTINEL),
    }));
    const summary = grantFailureCodes(new RewardGrantError([], failures));
    expect(summary).toContain('RWR_4 (BUSINESS_RULE_VIOLATION)');
    expect(summary).not.toContain('RWR_5');
    expect(summary.endsWith('; and 3 more')).toBe(true);
    expect(summary).not.toContain('SENTINEL');
  });

  it('names a non-error by kind', () => {
    expect(grantFailureCodes(SENTINEL)).toBe('non-error value');
  });
});
