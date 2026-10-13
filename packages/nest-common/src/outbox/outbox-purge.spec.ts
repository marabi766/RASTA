import {
  outboxPurgedTotal,
  outboxPurgeLastSuccessSeconds,
  outboxPurgeRunsTotal,
} from '@rasta/observability';

import {
  OutboxPurgeScheduler,
  outboxPurgeSettings,
  type OutboxPurgeLogger,
  type OutboxPurgeSchedulerOptions,
  type OutboxPurgeStore,
} from './outbox-purge';
import {
  MANUALLY_SKIPPED_PREFIX,
  purgePublishedSql,
  type OutboxPurgeTxRunner,
  type OutboxSqlClient,
  type PurgePublishedBatch,
  type PurgePublishedOptions,
} from './outbox-sql';

/** A store that answers each batch from a script, and records what it was asked. */
class ScriptedStore implements OutboxPurgeStore {
  readonly calls: PurgePublishedOptions[] = [];
  constructor(private readonly answers: (PurgePublishedBatch | Error)[]) {}

  async purgePublished(options: PurgePublishedOptions): Promise<PurgePublishedBatch> {
    this.calls.push(options);
    const answer = this.answers.shift() ?? { deleted: 0, busy: false };
    if (answer instanceof Error) throw answer;
    return answer;
  }
}

function recordingLogger() {
  const lines: { level: string; obj: Record<string, unknown>; msg?: string }[] = [];
  const at =
    (level: string) =>
    (obj: object, msg?: string): void => {
      lines.push({ level, obj: obj as Record<string, unknown>, msg });
    };
  const logger: OutboxPurgeLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
  return { logger, lines };
}

let serviceSeq = 0;
/** A fresh `service` label per test, so the shared metric registry cannot leak between tests. */
const freshService = () => `purge-spec-${++serviceSeq}`;

function scheduler(
  store: OutboxPurgeStore,
  overrides: Partial<OutboxPurgeSchedulerOptions> = {},
): OutboxPurgeScheduler {
  return new OutboxPurgeScheduler({
    store,
    service: freshService(),
    enabled: true,
    retentionHours: 168,
    intervalMs: 300_000,
    batchSize: 100,
    maxBatchesPerRun: 3,
    statementTimeoutMs: 5000,
    maxWaitMs: 2000,
    initialDelayMs: 0,
    ...overrides,
  });
}

async function counterValue(
  metric: typeof outboxPurgedTotal | typeof outboxPurgeRunsTotal,
  labels: Record<string, string>,
): Promise<number> {
  const { values } = await metric.get();
  const match = values.find((v) => {
    const actual: Readonly<Record<string, string | number | undefined>> = v.labels;
    return Object.entries(labels).every(([k, value]) => actual[k] === value);
  });
  return match?.value ?? 0;
}

async function lastSuccess(service: string): Promise<number | undefined> {
  const { values } = await outboxPurgeLastSuccessSeconds.get();
  return values.find((v) => v.labels.service === service)?.value;
}

describe('OutboxPurgeScheduler — one run', () => {
  it('asks for the retention in seconds, the batch size and both bounds', async () => {
    const store = new ScriptedStore([{ deleted: 7, busy: false }]);
    await scheduler(store, {
      retentionHours: 72,
      batchSize: 50,
      statementTimeoutMs: 1234,
      maxWaitMs: 321,
    }).runOnce();

    expect(store.calls).toEqual([
      { retentionSeconds: 72 * 3600, limit: 50, statementTimeoutMs: 1234, maxWaitMs: 321 },
    ]);
  });

  it('completes on the first short batch: nothing due is left', async () => {
    const store = new ScriptedStore([
      { deleted: 100, busy: false },
      { deleted: 40, busy: false },
    ]);
    const service = freshService();
    const run = await scheduler(store, { service }).runOnce();

    expect(run).toMatchObject({ outcome: 'completed', deleted: 140, batches: 2 });
    expect(store.calls).toHaveLength(2);
    expect(await counterValue(outboxPurgedTotal, { service })).toBe(140);
    expect(await counterValue(outboxPurgeRunsTotal, { service, outcome: 'completed' })).toBe(1);
    expect(await lastSuccess(service)).toBeGreaterThan(0);
  });

  it('stops at the per-run cap and reports `truncated`, so one run stays bounded', async () => {
    const store = new ScriptedStore([
      { deleted: 100, busy: false },
      { deleted: 100, busy: false },
      { deleted: 100, busy: false },
      { deleted: 100, busy: false },
    ]);
    const service = freshService();
    const { logger, lines } = recordingLogger();
    const run = await scheduler(store, { service, logger, maxBatchesPerRun: 3 }).runOnce();

    expect(run).toMatchObject({ outcome: 'truncated', deleted: 300, batches: 3 });
    expect(store.calls).toHaveLength(3);
    expect(await counterValue(outboxPurgeRunsTotal, { service, outcome: 'truncated' })).toBe(1);
    // Still progress: the gauge moves, and the warning says what to tune.
    expect(await lastSuccess(service)).toBeGreaterThan(0);
    const warning = lines.find((line) => line.level === 'warn');
    expect(warning?.obj).toMatchObject({ service, outcome: 'truncated', deleted: 300 });
    expect(warning?.msg).toMatch(/OUTBOX_PURGE_MAX_BATCHES_PER_RUN/);
  });

  it('ends at once as `busy` when another replica holds the purge lock', async () => {
    const store = new ScriptedStore([
      { deleted: 0, busy: true },
      { deleted: 100, busy: false },
    ]);
    const service = freshService();
    const run = await scheduler(store, { service }).runOnce();

    expect(run).toMatchObject({ outcome: 'busy', deleted: 0, batches: 0 });
    expect(store.calls).toHaveLength(1);
    expect(await counterValue(outboxPurgeRunsTotal, { service, outcome: 'busy' })).toBe(1);
    // Another replica is purging; this one has not succeeded at anything.
    expect(await lastSuccess(service)).toBeUndefined();
  });

  it('survives a failed batch: logged, counted, and earlier batches stay counted', async () => {
    const store = new ScriptedStore([
      { deleted: 100, busy: false },
      new Error('canceling statement'),
    ]);
    const service = freshService();
    const { logger, lines } = recordingLogger();
    const run = await scheduler(store, { service, logger }).runOnce();

    expect(run).toMatchObject({ outcome: 'failed', deleted: 100, batches: 1 });
    expect(await counterValue(outboxPurgedTotal, { service })).toBe(100);
    expect(await counterValue(outboxPurgeRunsTotal, { service, outcome: 'failed' })).toBe(1);
    expect(await lastSuccess(service)).toBeUndefined();
    const error = lines.find((line) => line.level === 'error');
    expect(error?.obj).toMatchObject({ service, deleted: 100, batches: 1 });
    expect((error?.obj.err as Error).message).toBe('canceling statement');
  });

  it('logs an idle run at debug and a productive one at info', async () => {
    const { logger, lines } = recordingLogger();
    await scheduler(new ScriptedStore([{ deleted: 0, busy: false }]), { logger }).runOnce();
    await scheduler(new ScriptedStore([{ deleted: 3, busy: false }]), { logger }).runOnce();

    expect(lines.map((line) => [line.level, line.obj.deleted])).toEqual([
      ['debug', 0],
      ['info', 3],
    ]);
  });

  it('joins a run already in flight instead of starting a second one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store: OutboxPurgeStore & { calls: number } = {
      calls: 0,
      async purgePublished() {
        this.calls += 1;
        await gate;
        return { deleted: 1, busy: false };
      },
    };
    const purge = scheduler(store);

    const first = purge.runOnce();
    const second = purge.runOnce();
    release();

    expect(await second).toBe(await first);
    expect(store.calls).toBe(1);
  });

  it.each([
    ['retentionHours', 0],
    ['intervalMs', -1],
    ['batchSize', 0],
    ['maxBatchesPerRun', 1.5],
    ['statementTimeoutMs', Number.NaN],
    ['maxWaitMs', 0],
  ] as const)('refuses %s = %p rather than running a purge that cannot be right', (name, value) => {
    expect(() => scheduler(new ScriptedStore([]), { [name]: value })).toThrow(name);
  });
});

describe('OutboxPurgeScheduler — schedule', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does nothing when disabled, and says so once', async () => {
    const store = new ScriptedStore([]);
    const { logger, lines } = recordingLogger();
    const purge = scheduler(store, { enabled: false, logger });

    purge.start();
    await jest.advanceTimersByTimeAsync(10 * 300_000);

    expect(store.calls).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn' });
    expect(lines[0].msg).toMatch(/OUTBOX_PURGE_ENABLED=false/);
    await purge.stop();
  });

  it('runs after the initial delay, then once per interval after each run ends', async () => {
    const store = new ScriptedStore([]);
    const purge = scheduler(store, { initialDelayMs: 1000, intervalMs: 60_000 });

    purge.start();
    await jest.advanceTimersByTimeAsync(999);
    expect(store.calls).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(store.calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(store.calls).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(store.calls).toHaveLength(3);

    await purge.stop();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(store.calls).toHaveLength(3);
  });

  it('never overlaps runs: the next interval starts only when a slow run has finished', async () => {
    let release!: () => void;
    const store: OutboxPurgeStore & { calls: number } = {
      calls: 0,
      async purgePublished() {
        this.calls += 1;
        if (this.calls === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { deleted: 0, busy: false };
      },
    };
    const purge = scheduler(store, { initialDelayMs: 0, intervalMs: 1000 });

    purge.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(store.calls).toBe(1);
    // Ten intervals pass while the first run is still in its batch.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(store.calls).toBe(1);

    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(store.calls).toBe(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(store.calls).toBe(2);
    await purge.stop();
  });

  it('stop() waits for the batch in flight and ends the run before the next batch', async () => {
    let release!: () => void;
    const calls: number[] = [];
    const store: OutboxPurgeStore = {
      async purgePublished() {
        calls.push(calls.length + 1);
        if (calls.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        // Full batches: without the stop this run would go on to its cap.
        return { deleted: 100, busy: false };
      },
    };
    const service = freshService();
    const purge = scheduler(store, { service, maxBatchesPerRun: 5 });

    purge.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([1]);

    let stopped = false;
    const stopping = purge.stop().then(() => {
      stopped = true;
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(calls).toEqual([1]);
    expect(await counterValue(outboxPurgeRunsTotal, { service, outcome: 'stopped' })).toBe(1);
    expect(await counterValue(outboxPurgedTotal, { service })).toBe(100);
  });

  it('stop() waits no longer than one batch bound for a batch that never ends (Codex r1 #247)', async () => {
    // A batch stuck past every timeout — the case the bound exists for.
    const store: OutboxPurgeStore & { calls: number } = {
      calls: 0,
      purgePublished() {
        this.calls += 1;
        return new Promise<PurgePublishedBatch>(() => undefined);
      },
    };
    const { logger, lines } = recordingLogger();
    const purge = scheduler(store, { maxWaitMs: 1000, statementTimeoutMs: 2000, logger });
    // Connection wait + statement + the transaction margin.
    expect(purge.stopBoundMs).toBe(1000 + 2000 + 5000);

    purge.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(store.calls).toBe(1);

    let stopped = false;
    const stopping = purge.stop().then(() => {
      stopped = true;
    });
    await jest.advanceTimersByTimeAsync(7999);
    expect(stopped).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);
    const warning = lines.find((line) => line.level === 'warn');
    expect(warning?.obj).toMatchObject({ stopBoundMs: 8000 });
    expect(warning?.msg).toMatch(/abandoned/);
    // Nothing new is started afterwards, by the timer or otherwise.
    await jest.advanceTimersByTimeAsync(10 * 300_000);
    expect(store.calls).toBe(1);
  });

  it('starts no batch once stopped, not even a first one', async () => {
    const store = new ScriptedStore([{ deleted: 100, busy: false }]);
    const service = freshService();
    const purge = scheduler(store, { service });
    purge.start();
    await purge.stop();

    // A run requested after the stop (an operator task, a late timer) does nothing.
    expect(await purge.runOnce()).toMatchObject({ outcome: 'stopped', batches: 0, deleted: 0 });
    await jest.advanceTimersByTimeAsync(10 * 300_000);
    expect(store.calls).toHaveLength(0);
  });

  it('stops in onModuleDestroy, as the destroy phase that disconnects Prisma begins', async () => {
    let release!: () => void;
    const store: OutboxPurgeStore & { calls: number } = {
      calls: 0,
      async purgePublished() {
        this.calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { deleted: 100, busy: false };
      },
    };
    const purge = scheduler(store, { maxBatchesPerRun: 5 });
    purge.start();
    await jest.advanceTimersByTimeAsync(0);

    const destroyed = purge.onModuleDestroy();
    release();
    await destroyed;
    expect(store.calls).toBe(1);
    // onApplicationShutdown's later stop() returns at once.
    await purge.stop();
    expect(store.calls).toBe(1);
  });

  it('stop() with no run in flight returns at once', async () => {
    const purge = scheduler(new ScriptedStore([]), { initialDelayMs: 60_000 });
    purge.start();
    await expect(purge.stop()).resolves.toBeUndefined();
  });
});

describe('outboxPurgeSettings', () => {
  it('maps the validated environment, seconds to milliseconds', () => {
    expect(
      outboxPurgeSettings({
        OUTBOX_PURGE_ENABLED: false,
        OUTBOX_PURGE_RETENTION_HOURS: 24,
        OUTBOX_PURGE_INTERVAL_SECONDS: 120,
        OUTBOX_PURGE_BATCH_SIZE: 500,
        OUTBOX_PURGE_MAX_BATCHES_PER_RUN: 8,
        OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: 3000,
        OUTBOX_PURGE_MAX_WAIT_MS: 1500,
      }),
    ).toEqual({
      enabled: false,
      retentionHours: 24,
      intervalMs: 120_000,
      batchSize: 500,
      maxBatchesPerRun: 8,
      statementTimeoutMs: 3000,
      maxWaitMs: 1500,
    });
  });
});

describe('purgePublishedSql', () => {
  /** A transaction runner over a fake client that records every statement. */
  function fakeTx(acquired: boolean, deleted = 0) {
    const statements: string[] = [];
    let bounds = { timeoutMs: 0, maxWaitMs: 0 };
    const client: OutboxSqlClient = {
      async $queryRawUnsafe<T>(query: string): Promise<T> {
        statements.push(query);
        return [{ acquired }] as T;
      },
      async $executeRawUnsafe(query: string): Promise<number> {
        statements.push(query);
        return query.includes('DELETE') ? deleted : 0;
      },
    };
    const run: OutboxPurgeTxRunner = (fn, given) => {
      bounds = given;
      return fn(client);
    };
    return { run, statements, bounds: () => bounds };
  }

  const options = {
    retentionSeconds: 604_800,
    limit: 1000,
    statementTimeoutMs: 5000,
    maxWaitMs: 2000,
  };
  const flat = (sql: string) => sql.replace(/\s+/g, ' ');

  it('bounds the batch, takes the replica lock, and deletes only published, unclaimed, old rows', async () => {
    const tx = fakeTx(true, 42);
    const batch = await purgePublishedSql(tx.run, options);

    expect(batch).toEqual({ deleted: 42, busy: false });
    const [timeout, lock, del] = tx.statements.map(flat);
    expect(timeout).toBe('SET LOCAL statement_timeout = 5000');
    expect(lock).toContain('pg_try_advisory_xact_lock');
    expect(lock).toContain('current_schema()');
    expect(del).toContain('published_at IS NOT NULL');
    expect(del).toContain('published_at < now() - make_interval(secs => 604800)');
    expect(del).toContain('created_at < now() - make_interval(secs => 604800)');
    expect(del).toContain(`last_error NOT LIKE '${MANUALLY_SKIPPED_PREFIX}%'`);
    expect(del).toContain('LIMIT 1000 FOR UPDATE SKIP LOCKED');
    // Re-checked on the locked row, not only in the selection.
    expect(del).toMatch(
      /WHERE o\.id = doomed\.id AND o\.published_at IS NOT NULL AND o\.claim_token IS NULL/,
    );
    // The database clock decides, never the caller's.
    expect(del).not.toMatch(/\$\d/);
    // The transaction outlives the statement, so statement_timeout is what
    // applies; the wait for a connection is its own, separate bound.
    expect(tx.bounds()).toEqual({ timeoutMs: 10_000, maxWaitMs: 2000 });
  });

  it('reports `busy` and deletes nothing when another session holds the lock', async () => {
    const tx = fakeTx(false, 99);
    expect(await purgePublishedSql(tx.run, options)).toEqual({ deleted: 0, busy: true });
    expect(tx.statements.some((sql) => sql.includes('DELETE'))).toBe(false);
  });

  it.each([
    { retentionSeconds: 0 },
    { retentionSeconds: -3600 },
    { limit: 0 },
    { limit: 10.5 },
    { statementTimeoutMs: Number.NaN },
    { maxWaitMs: 0 },
    { maxWaitMs: -1 },
    { retentionSeconds: Number.MAX_VALUE },
  ])('refuses %p before touching the database (S-05)', async (bad) => {
    const tx = fakeTx(true);
    await expect(purgePublishedSql(tx.run, { ...options, ...bad })).rejects.toThrow(
      /must be a positive integer/,
    );
    expect(tx.statements).toHaveLength(0);
  });
});
