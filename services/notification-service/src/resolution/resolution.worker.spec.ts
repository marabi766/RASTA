import { registry } from '@rasta/observability';
import { tryGetContext } from '@rasta/nest-common';
import type { NotificationIntent } from '../generated/prisma';
import {
  LeaseLostError,
  type NotificationRepository,
} from '../notification/notification.repository';
import {
  RecipientResolutionError,
  type RecipientPort,
  type RecipientQuery,
} from '../recipients/recipient.port';
import type { ScrubbedLogger } from '../logging/scrub';
import { ResolutionWorker, type ResolutionWorkerOptions } from './resolution.worker';

const options: ResolutionWorkerOptions = {
  pollIntervalMs: 60_000,
  batchSize: 10,
  leaseSeconds: 60,
  backoffMaxSeconds: 600,
  maxRecipients: 500,
  inAppTtlDays: 60,
  owner: 'worker-test',
};

function intent(overrides: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    id: 'NTI_1',
    organizationId: 'ORG_A',
    sourceEventId: 'EVT_1',
    sourceEventName: 'INSURANCE_EXPIRING',
    sourceTopic: 'rasta.insurance.v1',
    sourcePartitionKey: 'POL_1',
    sourceStreamSeq: null,
    occurredAt: new Date('2026-09-17T06:00:00.000Z'),
    correlationId: 'COR_1',
    causationId: null,
    ruleKey: 'insurance.expiring',
    templateKey: 'insurance.expiring.in-app',
    severity: 'WARNING',
    classification: 'ROUTINE',
    subjectType: 'InsurancePolicy',
    subjectId: 'POL_1',
    dedupeKey: 'a'.repeat(64),
    contextData: {
      assetId: 'AST_1',
      policyId: 'POL_1',
      insurerName: 'Insurer',
      validTo: '2026-10-17',
      daysRemaining: 7,
    },
    status: 'PENDING',
    resolutionAttempts: 0,
    nextResolutionAt: new Date(),
    lastResolutionError: null,
    claimToken: 'token-1',
    claimOwner: 'worker-test',
    claimExpiresAt: new Date(Date.now() + 60_000),
    resolvedAt: null,
    dispatchedAt: null,
    terminalReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface FakeRepository {
  repository: NotificationRepository;
  claimed: NotificationIntent[];
  deferred: { id: string; errorClass: string; nextResolutionAt: Date }[];
  suppressed: { id: string; reason: string }[];
  dispatched: Parameters<NotificationRepository['dispatchInApp']>[0][];
  contextsSeen: (string | undefined)[];
  dispatchError?: Error;
}

function fakeRepository(claimed: NotificationIntent[]): FakeRepository {
  const state: FakeRepository = {
    claimed,
    deferred: [],
    suppressed: [],
    dispatched: [],
    contextsSeen: [],
    repository: undefined as unknown as NotificationRepository,
  };
  state.repository = {
    claimPending: jest.fn(async () => state.claimed),
    deferResolution: jest.fn(
      async (row: NotificationIntent, errorClass: string, nextResolutionAt: Date) => {
        state.contextsSeen.push(tryGetContext()?.organizationId);
        state.deferred.push({ id: row.id, errorClass, nextResolutionAt });
        return true;
      },
    ),
    suppress: jest.fn(async (row: NotificationIntent, reason: string) => {
      state.contextsSeen.push(tryGetContext()?.organizationId);
      state.suppressed.push({ id: row.id, reason });
      return true;
    }),
    dispatchInApp: jest.fn(
      async (input: Parameters<NotificationRepository['dispatchInApp']>[0]) => {
        state.contextsSeen.push(tryGetContext()?.organizationId);
        if (state.dispatchError) throw state.dispatchError;
        state.dispatched.push(input);
        const failed = 'errorClass' in input.rendered;
        return {
          deliveries: input.recipients.length,
          inApp: failed ? 0 : input.recipients.length,
          // The stub never suppresses. The preference ladder is exercised
          // exhaustively in `precedence.spec.ts` and against a real database in
          // the integration suite; deciding it here would be testing the fake.
          suppressed: 0,
        };
      },
    ),
    pendingSummary: jest.fn(async () => ({ pending: 0, oldestAgeSeconds: 0 })),
  } as unknown as NotificationRepository;
  return state;
}

function port(
  handler: (
    query: RecipientQuery,
  ) => Promise<{ recipients: { userId: string; role: string }[]; truncated: boolean }>,
): RecipientPort & { queries: RecipientQuery[] } {
  const queries: RecipientQuery[] = [];
  return {
    queries,
    resolve: async (query) => {
      queries.push(query);
      return handler(query);
    },
  };
}

function silent(): ScrubbedLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (message: string) => void lines.push(message);
  return { lines, info: push, warn: push, error: push, debug: push };
}

async function counter(name: string, labels: Record<string, string>): Promise<number> {
  const metric = await registry.getSingleMetric(name)?.get();
  const sample = metric?.values.find((value) =>
    Object.entries(labels).every(([key, expected]) => value.labels[key] === expected),
  );
  return sample?.value ?? 0;
}

describe('ResolutionWorker', () => {
  it('dispatches one in-app delivery per resolved recipient, inside the intent tenant context', async () => {
    const repo = fakeRepository([intent()]);
    const recipients = port(async () => ({
      recipients: [
        { userId: 'USR_1', role: 'FLEET_MANAGER' },
        { userId: 'USR_2', role: 'ORGANIZATION_ADMIN' },
      ],
      truncated: false,
    }));
    const worker = new ResolutionWorker(repo.repository, recipients, options, silent());
    const before = await counter('rasta_notification_deliveries_total', {
      channel: 'IN_APP',
      status: 'SENT',
    });

    await expect(worker.tick()).resolves.toBe(1);

    expect(recipients.queries[0]).toMatchObject({
      organizationId: 'ORG_A',
      roles: ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'],
      limit: 500,
      correlationId: 'COR_1',
    });
    expect(repo.dispatched).toHaveLength(1);
    const dispatched = repo.dispatched[0]!;
    expect(dispatched.recipients).toEqual([
      { userId: 'USR_1', role: 'FLEET_MANAGER' },
      { userId: 'USR_2', role: 'ORGANIZATION_ADMIN' },
    ]);
    expect('title' in dispatched.rendered && dispatched.rendered.body).toContain('AST_1');
    expect(dispatched.inAppTtlDays).toBe(60);
    // Every repository write ran with the intent's organization as the tenant.
    expect(repo.contextsSeen).toEqual(['ORG_A']);
    expect(
      await counter('rasta_notification_deliveries_total', { channel: 'IN_APP', status: 'SENT' }),
    ).toBe(before + 2);
  });

  it('defers with backoff when identity is unavailable, and never dispatches', async () => {
    const repo = fakeRepository([intent({ resolutionAttempts: 2 })]);
    const recipients = port(async () => {
      throw new RecipientResolutionError('UNREACHABLE', 'down');
    });
    const logger = silent();
    const worker = new ResolutionWorker(repo.repository, recipients, options, logger);
    const before = await counter('rasta_notification_recipient_resolution_failures_total', {
      reason: 'UNREACHABLE',
    });
    const started = Date.now();

    await worker.tick();

    expect(repo.dispatched).toHaveLength(0);
    expect(repo.suppressed).toHaveLength(0);
    expect(repo.deferred).toHaveLength(1);
    expect(repo.deferred[0]!.errorClass).toBe('UNREACHABLE');
    // Third attempt → the 30 s rung, jittered to [15, 30].
    const delay = repo.deferred[0]!.nextResolutionAt.getTime() - started;
    expect(delay).toBeGreaterThanOrEqual(15_000 - 50);
    expect(delay).toBeLessThanOrEqual(30_000 + 50);
    expect(
      await counter('rasta_notification_recipient_resolution_failures_total', {
        reason: 'UNREACHABLE',
      }),
    ).toBe(before + 1);
    expect(logger.lines.join('\n')).toContain('retry at');
  });

  it('classifies an unexpected port error as UNREACHABLE rather than crashing the tick', async () => {
    const repo = fakeRepository([intent()]);
    const recipients = port(async () => {
      throw new TypeError('boom');
    });
    const worker = new ResolutionWorker(repo.repository, recipients, options, silent());

    await worker.tick();
    expect(repo.deferred[0]!.errorClass).toBe('UNREACHABLE');
  });

  it('suppresses an intent nobody is entitled to, and records why', async () => {
    const repo = fakeRepository([intent()]);
    const recipients = port(async () => ({ recipients: [], truncated: false }));
    const worker = new ResolutionWorker(repo.repository, recipients, options, silent());
    const before = await counter('rasta_notification_suppressed_total', {
      reason: 'NO_ELIGIBLE_RECIPIENT',
    });

    await worker.tick();

    expect(repo.suppressed).toEqual([{ id: 'NTI_1', reason: 'NO_ELIGIBLE_RECIPIENT' }]);
    expect(repo.dispatched).toHaveLength(0);
    expect(
      await counter('rasta_notification_suppressed_total', { reason: 'NO_ELIGIBLE_RECIPIENT' }),
    ).toBe(before + 1);
  });

  it('suppresses an intent whose rule no longer exists', async () => {
    const repo = fakeRepository([intent({ ruleKey: 'removed.rule' })]);
    const recipients = port(async () => {
      throw new Error('must not be called');
    });
    const worker = new ResolutionWorker(repo.repository, recipients, options, silent());

    await worker.tick();
    expect(repo.suppressed).toEqual([{ id: 'NTI_1', reason: 'RULE_UNKNOWN' }]);
    expect(recipients.queries).toHaveLength(0);
  });

  it('records a render failure on every delivery instead of dead-lettering anything', async () => {
    const repo = fakeRepository([intent({ contextData: { assetId: 'AST_1' } })]);
    const recipients = port(async () => ({
      recipients: [{ userId: 'USR_1', role: 'FLEET_MANAGER' }],
      truncated: false,
    }));
    const logger = silent();
    const worker = new ResolutionWorker(repo.repository, recipients, options, logger);
    const before = await counter('rasta_notification_deliveries_total', {
      channel: 'IN_APP',
      status: 'FAILED',
    });

    await expect(worker.tick()).resolves.toBe(1);

    expect(repo.dispatched).toHaveLength(1);
    expect(repo.dispatched[0]!.rendered).toEqual({ errorClass: 'RENDER_FAILED' });
    expect(
      await counter('rasta_notification_deliveries_total', { channel: 'IN_APP', status: 'FAILED' }),
    ).toBe(before + 1);
    expect(logger.lines.join('\n')).toContain('cannot render');
    expect(logger.lines.join('\n')).toContain('insurerName');
  });

  it('counts and warns when the recipient list was truncated, and still dispatches', async () => {
    const repo = fakeRepository([intent()]);
    const recipients = port(async () => ({
      recipients: [{ userId: 'USR_1', role: 'FLEET_MANAGER' }],
      truncated: true,
    }));
    const logger = silent();
    const worker = new ResolutionWorker(repo.repository, recipients, options, logger);
    const before = await counter('rasta_notification_recipient_truncated_total', {
      rule_key: 'insurance.expiring',
    });

    await worker.tick();

    expect(
      await counter('rasta_notification_recipient_truncated_total', {
        rule_key: 'insurance.expiring',
      }),
    ).toBe(before + 1);
    expect(repo.dispatched).toHaveLength(1);
    expect(logger.lines.join('\n')).toContain('truncated');
  });

  it("treats a lost lease as somebody else's work, not an error", async () => {
    const repo = fakeRepository([intent()]);
    repo.dispatchError = new LeaseLostError('NTI_1');
    const recipients = port(async () => ({
      recipients: [{ userId: 'USR_1', role: 'FLEET_MANAGER' }],
      truncated: false,
    }));
    const logger = silent();
    const worker = new ResolutionWorker(repo.repository, recipients, options, logger);
    const before = await counter('rasta_notification_recipient_resolution_failures_total', {
      reason: 'LEASE_LOST',
    });

    await expect(worker.tick()).resolves.toBe(1);
    expect(
      await counter('rasta_notification_recipient_resolution_failures_total', {
        reason: 'LEASE_LOST',
      }),
    ).toBe(before + 1);
    expect(logger.lines.join('\n')).toContain('taken over');
  });

  it('lets any other dispatch failure propagate from the tick', async () => {
    const repo = fakeRepository([intent()]);
    repo.dispatchError = new Error('disk full');
    const recipients = port(async () => ({
      recipients: [{ userId: 'USR_1', role: 'FLEET_MANAGER' }],
      truncated: false,
    }));
    const worker = new ResolutionWorker(repo.repository, recipients, options, silent());

    await expect(worker.tick()).rejects.toThrow('disk full');
  });

  it('processes each claimed intent in its own tenant context', async () => {
    const repo = fakeRepository([
      intent({ id: 'NTI_A', organizationId: 'ORG_A' }),
      intent({ id: 'NTI_B', organizationId: 'ORG_B' }),
    ]);
    const recipients = port(async (query) => ({
      recipients: [{ userId: `USR_${query.organizationId}`, role: 'FLEET_MANAGER' }],
      truncated: false,
    }));
    const worker = new ResolutionWorker(repo.repository, recipients, options, silent());

    await worker.tick();
    expect(repo.contextsSeen).toEqual(['ORG_A', 'ORG_B']);
    expect(repo.dispatched.map((d) => d.recipients[0]!.userId)).toEqual(['USR_ORG_A', 'USR_ORG_B']);
  });

  it('starts and stops its timers, reporting the state honestly', async () => {
    const repo = fakeRepository([]);
    const worker = new ResolutionWorker(
      repo.repository,
      port(async () => ({ recipients: [], truncated: false })),
      options,
      silent(),
    );

    expect(worker.isRunning()).toBe(false);
    worker.start();
    expect(worker.isRunning()).toBe(true);
    worker.start(); // idempotent
    await worker.stop();
    expect(worker.isRunning()).toBe(false);
    await worker.onApplicationShutdown();
  });

  it('logs and survives a failing tick when driven by the timer', async () => {
    jest.useFakeTimers();
    try {
      const repo = fakeRepository([]);
      (repo.repository.claimPending as jest.Mock).mockRejectedValueOnce(new Error('db away'));
      const logger = silent();
      const worker = new ResolutionWorker(
        repo.repository,
        port(async () => ({ recipients: [], truncated: false })),
        { ...options, pollIntervalMs: 100 },
        logger,
      );
      worker.start();
      await jest.advanceTimersByTimeAsync(250);
      await worker.stop();
      expect(logger.lines.join('\n')).toContain('Resolution tick failed');
      expect(worker.isRunning()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
