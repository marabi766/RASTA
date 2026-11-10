import { createSafePrismaClient } from '@rasta/nest-common';
import { Test } from '@nestjs/testing';
import { ENV } from '../tokens';
import { AppModule } from '../app.module';
import type { AuditRepository } from './audit.repository';
import { ReconciliationEvidenceMonitor } from './reconciliation-evidence-monitor';
import {
  auditIngestionFailuresTotal,
  auditPartitionRows,
  auditReconciliationEvidenceMissing,
  auditRfqOverdueLinks,
  auditRfqPendingLinks,
  auditRfqPendingOldestAgeSeconds,
  auditTenderOverdueLinks,
  auditTenderPendingLinks,
  auditTenderPendingOldestAgeSeconds,
} from '../observability/metrics';
import { PrismaService } from '../prisma/prisma.service';
import { RfqEvidenceRepository } from './rfq-evidence.repository';
import { RfqGapMonitor } from './rfq-gap-monitor';
import { SamplingLoop } from './sampling-loop';
import { TenderEvidenceRepository } from './tender-evidence.repository';
import { TenderGapMonitor } from './tender-gap-monitor';

/**
 * Shutdown ordering (Codex on #590, F3): a gap sample whose first query is still running when
 * the application closes must finish **before** the database client disconnects. Nest runs the
 * providers' destroy hooks concurrently, so the proof is a real Nest module closed for real —
 * the monitor's own async hook alone would pass a test that only calls it.
 */

const SUMMARY = [{ held: 0n, overdue: 0n, oldest: null }];

/** A database whose `heldQuery`-th query is held until the test releases it, and which counts what runs after `$disconnect`. */
function slowDatabase(heldQuery = 1) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { queries: 0, queriesAfterDisconnect: 0, disconnected: false };
  const client = {
    $extends: (_extension: unknown): object => client,
    $connect: async () => undefined,
    $disconnect: async () => {
      state.disconnected = true;
    },
    $queryRaw: async () => {
      state.queries += 1;
      if (state.disconnected) state.queriesAfterDisconnect += 1;
      if (state.queries === heldQuery) {
        await gate;
      }
      return state.queries === 1 ? SUMMARY : [];
    },
  };
  return { client, state, release };
}

/** Every metric a gap sample writes. */
const RFQ_WRITES = [
  auditRfqPendingLinks,
  auditRfqPendingOldestAgeSeconds,
  auditRfqOverdueLinks,
  auditIngestionFailuresTotal,
];
const TENDER_WRITES = [
  auditTenderPendingLinks,
  auditTenderPendingOldestAgeSeconds,
  auditTenderOverdueLinks,
  auditIngestionFailuresTotal,
];

/** Lets promise continuations that are ready run (the fake clock leaves `setImmediate` real). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function fakeClock(): void {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
}

describe.each([
  ['RFQ', RfqGapMonitor, RfqEvidenceRepository, { AUDIT_RFQ_GAP_ALERT_SECONDS: 300 }, RFQ_WRITES],
  [
    'tender',
    TenderGapMonitor,
    TenderEvidenceRepository,
    { AUDIT_TENDER_GAP_ALERT_SECONDS: 300 },
    TENDER_WRITES,
  ],
] as const)('the %s gap monitor at shutdown', (_name, Monitor, Repository, env, writes) => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Query number `heldQuery` outlives the deadline; it is released only AFTER the client has disconnected. */
  async function abandonedAtDeadline(heldQuery: number): Promise<{
    state: ReturnType<typeof slowDatabase>['state'];
    sets: jest.SpyInstance[];
  }> {
    fakeClock();
    const { client, state, release } = slowDatabase(heldQuery);
    const sets = writes.map((metric) =>
      jest.spyOn(metric as { set?: () => void; inc: () => void }, 'set' in metric ? 'set' : 'inc'),
    );
    const prisma = new PrismaService('postgresql://nobody:nothing@127.0.0.1:1/none');
    Object.defineProperty(prisma, 'client', {
      value: createSafePrismaClient(() => client, 'DATABASE_URL_AUDIT'),
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: ENV, useValue: env },
        Repository,
        Monitor,
      ],
    }).compile();
    await moduleRef.init(); // the first sample starts
    await settle();
    expect(state.queries).toBe(heldQuery); // the sample is parked inside query `heldQuery`

    const closing = moduleRef.close();
    await jest.advanceTimersByTimeAsync(5_000); // the deadline expires with the sample in flight
    await closing;
    expect(state.disconnected).toBe(true);

    if (heldQuery === 1)
      release(); // only now does the abandoned sample resume
    else release();
    await settle();
    return { state, sets };
  }

  it('finishes the sample in flight before the database disconnects: no query after $disconnect', async () => {
    const { client, state, release } = slowDatabase();
    const prisma = new PrismaService('postgresql://nobody:nothing@127.0.0.1:1/none');
    Object.defineProperty(prisma, 'client', {
      value: createSafePrismaClient(() => client, 'DATABASE_URL_AUDIT'),
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: ENV, useValue: env },
        Repository,
        Monitor,
      ],
    }).compile();
    await moduleRef.init(); // the monitor starts its first sample: query 1 is held
    expect(state.queries).toBe(1);

    const closing = moduleRef.close(); // every destroy hook, concurrently
    await new Promise((resolve) => setImmediate(resolve));
    // The client must still be connected while the sample is in flight.
    expect(state.disconnected).toBe(false);

    release();
    await closing;

    expect(state.disconnected).toBe(true);
    expect(state.queries).toBe(2); // the sample ran to its end...
    expect(state.queriesAfterDisconnect).toBe(0); // ...before the client went away
  });

  it('after the deadline: the abandoned sample runs no further query and writes no metric (first query held)', async () => {
    const { state, sets } = await abandonedAtDeadline(1);
    expect(state.queries).toBe(1); // no second query, neither before nor after the disconnect
    expect(state.queriesAfterDisconnect).toBe(0);
    for (const set of sets) expect(set).not.toHaveBeenCalled();
  });

  it('after the deadline: a sample held in its LAST query writes no metric when it resumes', async () => {
    const { state, sets } = await abandonedAtDeadline(2);
    expect(state.queries).toBe(2);
    expect(state.queriesAfterDisconnect).toBe(0);
    for (const set of sets) expect(set).not.toHaveBeenCalled();
  });
});

describe('SamplingLoop', () => {
  it('stops scheduling: no sample starts once stopped', async () => {
    jest.useFakeTimers();
    try {
      const sample = jest.fn(async () => undefined);
      const loop = new SamplingLoop(sample, 1_000);
      loop.start();
      expect(sample).toHaveBeenCalledTimes(1);
      const stopped = loop.stop();
      await jest.advanceTimersByTimeAsync(5_000);
      await stopped;
      expect(sample).toHaveBeenCalledTimes(1);
      loop.start(); // a stopped loop stays stopped
      await jest.advanceTimersByTimeAsync(5_000);
      expect(sample).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for a bounded time only: a sample that never ends does not hold the shutdown', async () => {
    const loop = new SamplingLoop(() => new Promise<void>(() => undefined), 60_000, 25);
    loop.start();
    const began = Date.now();
    await loop.stop();
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  it('does not overlap a slow sample with the next tick', async () => {
    jest.useFakeTimers();
    try {
      let release!: () => void;
      const sample = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const loop = new SamplingLoop(sample, 1_000);
      loop.start();
      await jest.advanceTimersByTimeAsync(3_000);
      expect(sample).toHaveBeenCalledTimes(1);
      release();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(sample).toHaveBeenCalledTimes(2);
      release();
      await loop.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the other samplers at the shutdown deadline', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('reconciliation monitor: a query that resumes after the deadline writes no metric', async () => {
    fakeClock();
    let release!: (missing: number) => void;
    const countMissingReconciliationEvidence = jest.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    const hooks: (() => Promise<void>)[] = [];
    const monitor = new ReconciliationEvidenceMonitor(
      { countMissingReconciliationEvidence } as unknown as AuditRepository,
      { AUDIT_RECONCILIATION_EVIDENCE_LOOKBACK_HOURS: 24 } as never,
      { beforeDisconnect: (stop: () => Promise<void>) => hooks.push(stop) } as never,
    );
    const set = jest.spyOn(auditReconciliationEvidenceMissing, 'set');
    monitor.onModuleInit();
    await settle();
    expect(countMissingReconciliationEvidence).toHaveBeenCalledTimes(1);

    const stopping = hooks[0]!();
    await jest.advanceTimersByTimeAsync(5_000);
    await stopping;
    release(7); // after the deadline
    await settle();

    expect(set).not.toHaveBeenCalled();
    expect(countMissingReconciliationEvidence).toHaveBeenCalledTimes(1);
  });

  it('capacity sampler: a query that resumes after the deadline writes no gauge', async () => {
    fakeClock();
    let release!: (rows: { partition: string; rows: number }[]) => void;
    const partitionRowCounts = jest.fn(
      () =>
        new Promise<{ partition: string; rows: number }[]>((resolve) => {
          release = resolve;
        }),
    );
    const noop = { isRunning: () => true, start: async () => undefined } as never;
    const module = new AppModule(
      noop,
      noop,
      noop,
      noop,
      noop,
      { partitionRowCounts } as unknown as AuditRepository,
      {
        AUDIT_EXPECTED_ACTIVE_PRODUCERS: [],
      } as never,
      { assertRuntimeRole: async () => undefined, beforeDisconnect: () => undefined } as never,
    );
    const set = jest.spyOn(auditPartitionRows, 'set');
    await module.onModuleInit();
    await settle();
    expect(partitionRowCounts).toHaveBeenCalledTimes(1);

    const stopping = module.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(5_000);
    await stopping;
    release([{ partition: 'audit_event_default', rows: 9 }]);
    await settle();

    expect(set).not.toHaveBeenCalled();
  });
});
