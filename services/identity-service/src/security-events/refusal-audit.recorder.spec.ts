import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, type RequestContext } from '@rasta/nest-common';
import {
  securityEventAggregationsTotal,
  securityEventCapturesTotal,
  SECURITY_EVENT_AGGREGATION_RESULTS,
  SECURITY_EVENT_CAPTURE_OUTCOMES,
} from '../observability/security-event.metrics';
import type { SecurityEventRecord } from './audit-trail-envelope';
import { MAX_OCCURRENCE_COUNT, type CapturedOccurrence } from './refusal-aggregation';
import type { RefusalObservation } from './refusal-capture';
import { RefusalAuditRecorder, type SecurityEventWriter } from './refusal-audit.recorder';
import { markRefusal, REFUSAL_SITES } from './refusal-sites';
import type { CaptureWriteOptions } from './security-event-outbox.store';

const NOW = new Date('2026-09-11T10:00:00.000Z');
const SENTINEL = 'SENSITIVE-SENTINEL-9f1c';

const context: RequestContext = {
  correlationId: 'COR_1',
  requestId: 'REQ_1',
  organizationId: 'ORG_A',
  organizationIds: ['ORG_A'],
  userId: 'USR_A',
  roles: ['FLEET_MANAGER'],
  authType: 'USER',
  ip: '203.0.113.7',
  userAgent: `agent ${SENTINEL}`,
  startedAt: 0,
};

function observation(overrides: Partial<RefusalObservation> = {}): RefusalObservation {
  return {
    exception: markRefusal(RastaError.tenantMismatch(SENTINEL, []), 'SWITCH_ACTIVE_ORGANIZATION'),
    status: 403,
    code: ERROR_CODES.TENANT_MISMATCH,
    method: 'POST',
    route: REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION.route,
    context,
    ...overrides,
  };
}

interface Harness {
  recorder: RefusalAuditRecorder;
  capture: jest.Mock<Promise<CapturedOccurrence>, [SecurityEventRecord, CaptureWriteOptions]>;
  logger: { warn: jest.Mock; error: jest.Mock };
}

const CREATED: CapturedOccurrence = {
  id: '01J9ZC0000000000000000TEST',
  occurrenceCount: 1,
  created: true,
};

function harness(
  capture: SecurityEventWriter['capture'] = async () => CREATED,
  timeoutMs = 50,
  aggregationWindowSeconds = 60,
): Harness {
  const mock = jest.fn(capture);
  const logger = { warn: jest.fn(), error: jest.fn() };
  const recorder = new RefusalAuditRecorder({
    store: { capture: mock },
    timeoutMs,
    aggregationWindowSeconds,
    producerVersion: '1.0.0',
    // The recorder only calls these two; the full pino surface is not needed.
    logger: logger as unknown as ConstructorParameters<typeof RefusalAuditRecorder>[0]['logger'],
    now: () => NOW,
    newId: () => '01J9ZC0000000000000000TEST',
  });
  return { recorder, capture: mock, logger };
}

async function captureCounts(): Promise<Record<string, number>> {
  const metric = await securityEventCapturesTotal.get();
  return Object.fromEntries(metric.values.map((v) => [String(v.labels.outcome), v.value]));
}

async function aggregationCounts(): Promise<Record<string, number>> {
  const metric = await securityEventAggregationsTotal.get();
  return Object.fromEntries(metric.values.map((v) => [String(v.labels.result), v.value]));
}

const logText = (h: Harness): string =>
  JSON.stringify([...h.logger.warn.mock.calls, ...h.logger.error.mock.calls]);

describe('RefusalAuditRecorder', () => {
  beforeEach(() => {
    securityEventCapturesTotal.reset();
    securityEventAggregationsTotal.reset();
  });

  it('records an allowlisted refusal with the configured timeout and window and counts it', async () => {
    const h = harness(undefined, 50, 17);

    await expect(h.recorder.record(observation())).resolves.toBe('recorded');

    expect(h.capture).toHaveBeenCalledTimes(1);
    const [draft, options] = h.capture.mock.calls[0]!;
    expect(options).toEqual({ timeoutMs: 50, windowSeconds: 17 });
    expect(draft).toMatchObject({
      organizationId: 'ORG_A',
      actorId: 'USR_A',
      errorCode: 'TENANT_MISMATCH',
      occurredAt: NOW,
      occurrenceCount: 1,
    });
    expect(await captureCounts()).toEqual({ recorded: 1 });
    expect(await aggregationCounts()).toEqual({ created: 1 });
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  describe('aggregation (AUD-004 Phase C2)', () => {
    it.each<[string, CapturedOccurrence, string]>([
      ['a new window row', CREATED, 'created'],
      ['a successor row after the ceiling', { ...CREATED, created: true }, 'created'],
      ['an increment', { ...CREATED, occurrenceCount: 500, created: false }, 'incremented'],
      [
        'the increment that reaches the INTEGER ceiling',
        { ...CREATED, occurrenceCount: MAX_OCCURRENCE_COUNT, created: false },
        'ceiling_reached',
      ],
    ])('reports %s as recorded, and its aggregation result apart', async (_l, captured, result) => {
      const h = harness(async () => captured);

      await expect(h.recorder.record(observation())).resolves.toBe('recorded');

      expect(await captureCounts()).toEqual({ recorded: 1 });
      expect(await aggregationCounts()).toEqual({ [result]: 1 });
      expect(h.logger.warn).not.toHaveBeenCalled();
      expect(h.logger.error).not.toHaveBeenCalled();
    });

    it('reports no aggregation result for a capture it could not confirm', async () => {
      await harness(() => new Promise<CapturedOccurrence>(() => undefined), 20).recorder.record(
        observation(),
      );
      await harness(async () => {
        throw new Error('down');
      }).recorder.record(observation());

      expect(await captureCounts()).toEqual({ timeout: 1, failed: 1 });
      expect(await aggregationCounts()).toEqual({});
    });

    it('labels the aggregation counter with the result alone, from a closed set', async () => {
      await harness().recorder.record(observation());
      await harness(async () => ({
        ...CREATED,
        occurrenceCount: 2,
        created: false,
      })).recorder.record(observation());

      const results = new Set<string>(Object.values(SECURITY_EVENT_AGGREGATION_RESULTS));
      const metric = await securityEventAggregationsTotal.get();
      expect(metric.values.length).toBe(2);
      for (const value of metric.values) {
        expect(Object.keys(value.labels)).toEqual(['result']);
        expect(results.has(String(value.labels.result))).toBe(true);
      }
      expect(JSON.stringify(metric)).not.toContain('USR_A');
      expect(JSON.stringify(metric)).not.toContain('ORG_A');
      expect(JSON.stringify(metric)).not.toContain(SENTINEL);
      expect(JSON.stringify(metric)).not.toContain(CREATED.id);
    });

    it.each([0, 3601, 1.5])('refuses to start with an aggregation window of %p seconds', (w) => {
      expect(() => harness(undefined, 50, w)).toThrow(RangeError);
    });

    it('never throws when the aggregation counter itself fails', async () => {
      const inc = jest.spyOn(securityEventAggregationsTotal, 'inc').mockImplementation(() => {
        throw new Error('registry broke');
      });
      try {
        await expect(harness().recorder.record(observation())).resolves.toBe('recorded');
      } finally {
        inc.mockRestore();
      }
    });
  });

  it.each([
    ['a 401', RastaError.unauthenticated()],
    ['an unrelated 403', RastaError.insufficientRole(['UNION_ADMIN'], [])],
    ["the guard's unmarked TENANT_MISMATCH", RastaError.tenantMismatch('ORG_B', ['ORG_A'])],
  ])('ignores %s entirely — no write, no count, no log', async (_label, exception) => {
    const h = harness();
    await expect(h.recorder.record(observation({ exception }))).resolves.toBeUndefined();
    expect(h.capture).not.toHaveBeenCalled();
    expect(await captureCounts()).toEqual({});
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('counts and logs a skipped marked refusal by closed reason only', async () => {
    const h = harness();
    await expect(
      h.recorder.record(observation({ context: { ...context, authType: 'ANONYMOUS' } })),
    ).resolves.toBe('skipped');
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(
      {
        site: 'identity.switch_active_organization',
        outcome: 'skipped',
        skipReason: 'not_authenticated_user',
      },
      expect.any(String),
    );
    expect(logText(h)).not.toContain(SENTINEL);
  });

  it('reports a failed write as failed, logging the class and code but never the message', async () => {
    const failure = Object.assign(new Error(`insert failed near value ${SENTINEL}`), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2010',
      meta: { code: '23514', message: SENTINEL },
    });
    const h = harness(async () => {
      throw failure;
    });

    await expect(h.recorder.record(observation())).resolves.toBe('failed');

    expect(await captureCounts()).toEqual({ failed: 1 });
    expect(h.logger.error).toHaveBeenCalledWith(
      {
        site: 'identity.switch_active_organization',
        outcome: 'failed',
        timeoutMs: 50,
        errorClass: 'PrismaClientKnownRequestError',
        errorCode: 'P2010',
      },
      expect.any(String),
    );
    expect(logText(h)).not.toContain(SENTINEL);
  });

  it.each([
    ['a Prisma transaction timeout', { code: 'P2028' }],
    ['a pool timeout', { code: 'P2024' }],
    ['a PostgreSQL statement cancellation', { code: 'P2010', meta: { code: '57014' } }],
    ['a PostgreSQL lock timeout', { meta: { code: '55P03' } }],
  ])('classifies %s as a timeout', async (_label, shape) => {
    const h = harness(async () => {
      throw Object.assign(new Error('x'), shape);
    });
    await expect(h.recorder.record(observation())).resolves.toBe('timeout');
    expect(await captureCounts()).toEqual({ timeout: 1 });
  });

  it('settles as a timeout within its deadline when the write never returns', async () => {
    const h = harness(() => new Promise<CapturedOccurrence>(() => undefined), 30);
    const started = Date.now();

    await expect(h.recorder.record(observation())).resolves.toBe('timeout');

    expect(Date.now() - started).toBeLessThan(1000);
    expect(await captureCounts()).toEqual({ timeout: 1 });
  });

  it('treats a write that throws synchronously as failed rather than throwing', async () => {
    const h = harness(() => {
      throw new TypeError(SENTINEL);
    });
    await expect(h.recorder.record(observation())).resolves.toBe('failed');
    expect(logText(h)).not.toContain(SENTINEL);
  });

  it('never throws, even when logging does', async () => {
    const h = harness(async () => {
      throw new Error('down');
    });
    h.logger.error.mockImplementation(() => {
      throw new Error('logger broke');
    });
    await expect(h.recorder.record(observation())).resolves.toBe('failed');
  });

  it('labels its counter with the outcome alone, from a closed set', async () => {
    const outcomes = new Set<string>(Object.values(SECURITY_EVENT_CAPTURE_OUTCOMES));
    await harness().recorder.record(observation());
    await harness(async () => {
      throw new Error('x');
    }).recorder.record(observation());
    await harness().recorder.record(observation({ route: undefined }));

    const metric = await securityEventCapturesTotal.get();
    expect(metric.values.length).toBeGreaterThan(0);
    for (const value of metric.values) {
      expect(Object.keys(value.labels)).toEqual(['outcome']);
      expect(outcomes.has(String(value.labels.outcome))).toBe(true);
    }
    expect(JSON.stringify(metric)).not.toContain('USR_A');
    expect(JSON.stringify(metric)).not.toContain('ORG_A');
    expect(JSON.stringify(metric)).not.toContain(SENTINEL);
  });
});
