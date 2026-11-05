import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestWorkflowEnvironment, MockActivityEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { temporalStep, type OrderActivities, type SagaOrderView } from './activities';
import {
  orderSaga,
  shouldRollSaga,
  SAGA_HISTORY_BYTES,
  SAGA_HISTORY_EVENTS,
  type OrderSagaInput,
  type SagaResume,
  type SagaStatus,
} from './workflows';

jest.setTimeout(120_000);
const INPUT: OrderSagaInput = {
  orderId: 'ORD_ROLLOVER',
  fulfillmentWindowDays: 1,
  receiptWindowDays: 1 / 24,
  reminderIntervalDays: 1 / 24,
  recheckIntervalHours: 1 / 6,
  historyEventThreshold: 32,
};

it('rolls on the event boundary, size boundary, or server suggestion, with old-server count fallback', () => {
  const small = { continueAsNewSuggested: false, historyLength: 20, historySize: 0 };
  expect(shouldRollSaga(small)).toBe(false);
  expect(shouldRollSaga({ ...small, historyLength: SAGA_HISTORY_EVENTS })).toBe(true);
  expect(shouldRollSaga({ ...small, historySize: SAGA_HISTORY_BYTES })).toBe(true);
  expect(shouldRollSaga({ ...small, continueAsNewSuggested: true })).toBe(true);
});

it('replays a fixed pre-change history with the new workflow code', async () => {
  const history: unknown = JSON.parse(
    readFileSync(join(__dirname, 'fixtures/pre-rollover.json'), 'utf8'),
  );
  await Worker.runReplayHistory(
    { workflowsPath: require.resolve('./workflows') },
    history,
    'order-ORD_HISTORY_PRE_ROLLOVER',
  );
});

it('step identity isolates runs and stays stable on retry for patched and legacy activity ids', async () => {
  const step = (runId: string, activityId: string) =>
    new MockActivityEnvironment({
      workflowExecution: { workflowId: 'order-ORD_ROLLOVER', runId },
      activityId,
    }).run<[], ReturnType<typeof temporalStep>, () => Promise<ReturnType<typeof temporalStep>>>(
      async () => temporalStep(),
    );
  expect((await step('RUN_A', 'saga-step-41')).key).toBe('order-ORD_ROLLOVER/RUN_A/saga-step-41');
  expect((await step('RUN_A', 'saga-step-41')).key).toBe((await step('RUN_A', 'saga-step-41')).key);
  expect((await step('RUN_B', 'saga-step-41')).key).not.toBe(
    (await step('RUN_A', 'saga-step-41')).key,
  );
  expect((await step('RUN_A', '41')).key).toBe('order-ORD_ROLLOVER/RUN_A/41');
});

describe('history rollover on real Temporal', () => {
  let env: TestWorkflowEnvironment;
  let serial = 0;
  // Real time, not workflow time: a slow runner takes seconds over each step.
  const eventually = async (holds: () => boolean): Promise<void> => {
    for (let i = 0; i < 3000 && !holds(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  // The saga waits with nothing in flight: its last commands are its timers,
  // or a task with no command at all, which is what answering a query leaves.
  // Skip time only from here, and land a signal between two rechecks, not on
  // one. The test server refuses a task that cancels a timer fired while the
  // task ran, and the saga then sits waiting for a retry.
  const atRest = async (workflowId: string): Promise<void> => {
    const handle = env.client.workflow.getHandle(workflowId);
    for (let i = 0; i < 300; i++) {
      const last = (await handle.fetchHistory()).events?.at(-1);
      if (
        last?.timerStartedEventAttributes ||
        last?.timerCanceledEventAttributes ||
        last?.workflowTaskCompletedEventAttributes
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${workflowId} did not come to rest`);
  };
  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 300_000);
  afterAll(async () => {
    await env?.teardown();
  });

  it('switches a running legacy command stream to the patch and replays its mixed history', async () => {
    // Exercise the legacy branch that the immutable pre-change fixture above
    // independently verifies. Disable patch adoption only for the first worker:
    // it stands for a release before both markers, so it records neither.
    const dir = mkdtempSync(join(__dirname, '.legacy-'));
    const source = readFileSync(require.resolve('./workflows.ts'), 'utf8');
    writeFileSync(
      join(dir, 'workflows.ts'),
      source
        .replaceAll('patched(ROLLOVER_PATCH)', 'false')
        .replaceAll('patched(DISPUTE_RESUME_PATCH)', 'false'),
    );
    try {
      const taskQueue = `rollover-mixed-${++serial}`;
      const ids: string[] = [];
      const activities = {
        readOrder: async () => {
          ids.push(Context.current().info.activityId);
          return {
            status: 'FUNDS_HELD',
            economicTransactionId: 'TXN_MIXED',
            cancellationReason: null,
            dispute: null,
          };
        },
      } satisfies Partial<OrderActivities>;
      const options = {
        connection: env.nativeConnection,
        taskQueue,
        activities,
        maxCachedWorkflows: 0,
      };
      const legacy = await Worker.create({ ...options, workflowsPath: join(dir, 'workflows.ts') });
      await legacy.runUntil(async () => {
        const handle = await env.client.workflow.start(orderSaga, {
          workflowId: taskQueue,
          taskQueue,
          args: [{ ...INPUT, historyEventThreshold: 2000 }],
        });
        let status: SagaStatus | undefined;
        for (let i = 0; i < 100; i++) {
          status = await handle.query<SagaStatus>('status');
          if (status.phase === 'AWAITING_CONFIRMATION') break;
          await env.sleep('1 second');
        }
        expect(status).toMatchObject({ phase: 'AWAITING_CONFIRMATION' });
      });
      const handle = env.client.workflow.getHandle(taskQueue);
      try {
        const before = await handle.fetchHistory();
        expect(before.events?.some((e) => e.markerRecordedEventAttributes)).toBe(false);
        expect(ids).toEqual(['1']);
        const patchedWorker = await Worker.create({
          ...options,
          workflowsPath: require.resolve('./workflows'),
        });
        await patchedWorker.runUntil(async () => {
          await handle.signal('orderConfirmed');
          // Query is ordered after the signal; wait for its asynchronous read.
          for (let i = 0; i < 100 && ids.length < 2; i++) await env.sleep('1 second');
          await handle.query('status');
          expect(ids).toEqual(['1', 'saga-step-1']);
          const mixed = await handle.fetchHistory();
          expect(
            mixed.events?.some((e) => e.markerRecordedEventAttributes?.markerName === 'core_patch'),
          ).toBe(true);
          await Worker.runReplayHistory(
            { workflowsPath: require.resolve('./workflows') },
            mixed,
            taskQueue,
          );
        });
      } finally {
        await handle.terminate();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves absolute reminder deadlines, counters and progress; replays both sides of rollover', async () => {
    const seen: { id: string; run: string }[] = [];
    const now = await env.currentTimeMs();
    const state: SagaOrderView = {
      status: 'AWAITING_RECEIPT_CONFIRMATION',
      economicTransactionId: 'TXN_ROLL',
      cancellationReason: null,
      dispute: null,
    };
    let reminders = 0;
    const activities = {
      readOrder: async () => {
        const info = Context.current().info;
        seen.push({ id: info.activityId, run: info.workflowExecution?.runId ?? '' });
        return { ...state };
      },
      recordReminder: async () => {
        reminders++;
      },
    } satisfies Partial<OrderActivities>;
    const taskQueue = `rollover-reminder-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        workflowId: taskQueue,
        taskQueue,
        args: [
          {
            ...INPUT,
            resume: {
              status: {
                phase: 'AWAITING_RECEIPT_CONFIRMATION',
                deferredSteps: ['RESERVE_STOCK', 'NOTIFY_SUPPLIER'],
                remindersRecorded: 7,
                settlementAttempts: 3,
              },
              waitingIn: 'AWAITING_RECEIPT_CONFIRMATION',
              nextReminderAt: now + 60 * 60_000,
              activitySequence: 40,
            },
          },
        ],
      });
      try {
        await handle.query('status');
        const first = (await handle.describe()).runId;
        await env.sleep('55 minutes');
        const latest = env.client.workflow.getHandle(taskQueue);
        expect(reminders).toBe(0);
        expect((await latest.describe()).runId).not.toBe(first);
        expect(await latest.query<SagaStatus>('status')).toMatchObject({
          remindersRecorded: 7,
          settlementAttempts: 3,
        });
        await env.sleep('10 minutes');
        expect(await latest.query<SagaStatus>('status')).toMatchObject({
          remindersRecorded: 8,
          settlementAttempts: 3,
        });
        expect(reminders).toBe(1);
        const previous = await env.client.workflow.getHandle(taskQueue, first).fetchHistory();
        const current = await latest.fetchHistory();
        await Worker.runReplayHistory(
          { workflowsPath: require.resolve('./workflows') },
          previous,
          taskQueue,
        );
        await Worker.runReplayHistory(
          { workflowsPath: require.resolve('./workflows') },
          current,
          taskQueue,
        );
        expect(new Set(seen.map((s) => s.run)).size).toBeGreaterThan(1);
        expect(new Set(seen.map((s) => s.id)).size).toBe(seen.length);
      } finally {
        await env.client.workflow.getHandle(taskQueue).terminate();
      }
    });
  });

  it('refuses to repeat initial financial progress when a resumed owner unexpectedly says PENDING', async () => {
    const createObligation = jest.fn();
    const activities = {
      readOrder: async () => ({
        status: 'PENDING',
        economicTransactionId: null,
        cancellationReason: null,
        dispute: null,
      }),
      createObligation,
      findObligation: async () => null,
      markFailed: async () => 'FAILED',
    };
    const taskQueue = `rollover-refusal-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities,
    });
    await worker.runUntil(async () => {
      await expect(
        env.client.workflow.execute(orderSaga, {
          workflowId: taskQueue,
          taskQueue,
          args: [
            {
              ...INPUT,
              resume: {
                status: {
                  phase: 'DISPUTED',
                  deferredSteps: [],
                  remindersRecorded: 7,
                  settlementAttempts: 3,
                },
                waitingIn: 'DISPUTED',
                activitySequence: 40,
              },
            },
          ],
        }),
      ).rejects.toMatchObject({ cause: { type: 'SAGA_INCONSISTENT' } });
      expect(createObligation).not.toHaveBeenCalled();
    });
  });

  it('keeps actual settlement progress when an economic dispute waits across rollover', async () => {
    const state: SagaOrderView = {
      status: 'RECEIPT_CONFIRMED',
      economicTransactionId: 'TXN_PROGRESS',
      cancellationReason: null,
      dispute: null,
    };
    const authoriseSettlement = jest.fn(async () => undefined);
    const settle = jest.fn(async () => ({
      disputed: true as const,
      reason: 'owner dispute',
      economicDisputeId: 'ECON_PROGRESS',
    }));
    const disputeObligation = jest.fn(async () => 'ECON_PROGRESS');
    const activities = {
      readOrder: async () => ({ ...state }),
      authoriseSettlement,
      settle,
      disputeObligation,
      markSettling: async () => {
        state.status = 'SETTLING';
        return state.status;
      },
      markSettlementFailed: async () => {
        state.status = 'RECEIPT_CONFIRMED';
        return state.status;
      },
      markObligationDisputed: async () => {
        state.status = 'DISPUTED';
        state.dispute = { id: 'DSP_PROGRESS', reason: 'owner dispute', resolution: null };
        return {
          status: state.status,
          disputeId: 'DSP_PROGRESS',
          economicDisputeId: 'ECON_PROGRESS',
        };
      },
    } satisfies Partial<OrderActivities>;
    const taskQueue = `rollover-financial-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        workflowId: taskQueue,
        taskQueue,
        args: [INPUT],
      });
      try {
        await env.sleep('1 hour');
        const latest = env.client.workflow.getHandle(taskQueue);
        expect((await latest.describe()).runId).not.toBe(handle.firstExecutionRunId);
        expect(await latest.query<SagaStatus>('status')).toMatchObject({
          phase: 'DISPUTED',
          settlementAttempts: 1,
        });
        expect(authoriseSettlement).toHaveBeenCalledTimes(1);
        expect(settle).toHaveBeenCalledTimes(1);
        expect(disputeObligation).not.toHaveBeenCalled();
      } finally {
        await env.client.workflow.getHandle(taskQueue).terminate();
      }
    });
  });

  it('preserves both dispute identities and mirrors the old decision before a new dispute', async () => {
    const old = { id: 'DSP_OLD', reason: 'old', resolution: null as string | null };
    const state: SagaOrderView = {
      status: 'DISPUTED',
      economicTransactionId: 'TXN_ROLL',
      cancellationReason: null,
      dispute: old,
    };
    const resolutions: unknown[][] = [];
    const disputes: string[] = [];
    const activities = {
      readOrder: async (_id: string, mirrored?: string) => ({
        ...state,
        ...(mirrored ? { mirroredDispute: { id: mirrored, resolution: old.resolution } } : {}),
      }),
      disputeObligation: async (_order: string, _txn: string, dispute: string) => {
        disputes.push(dispute);
        return dispute === old.id ? 'ECON_OLD' : 'ECON_NEW';
      },
      resolveObligationDispute: async (...args: unknown[]) => {
        resolutions.push(args);
      },
    } satisfies Partial<OrderActivities>;
    const taskQueue = `rollover-dispute-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        workflowId: taskQueue,
        taskQueue,
        args: [INPUT],
      });
      try {
        await handle.query('status');
        const first = (await handle.describe()).runId;
        await env.sleep('1 hour');
        const latest = env.client.workflow.getHandle(taskQueue);
        expect((await latest.describe()).runId).not.toBe(first);
        expect(disputes).toEqual(['DSP_OLD']);
        old.resolution = 'old decision';
        state.dispute = { id: 'DSP_NEW', reason: 'new', resolution: null };
        await latest.signal('orderDisputed', 'ignored');
        for (let i = 0; i < 100 && disputes.length < 2; i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(resolutions).toEqual([
          [INPUT.orderId, 'TXN_ROLL', 'DSP_OLD', 'old decision', 'ECON_OLD'],
        ]);
        expect(disputes).toEqual(['DSP_OLD', 'DSP_NEW']);
        await env.sleep('1 hour');
        expect(disputes).toEqual(['DSP_OLD', 'DSP_NEW']);
      } finally {
        await env.client.workflow.getHandle(taskQueue).terminate();
      }
    });
  });

  it('rolls over inside the release wait: the next run keeps its dispute, rounds and deadlines (FU-080)', async () => {
    const state: SagaOrderView = {
      status: 'FUNDS_HELD',
      economicTransactionId: 'TXN_RELEASE',
      cancellationReason: null,
      dispute: null,
    };
    const sent: unknown[][] = [];
    const rounds: number[] = [];
    let recovered = false;
    const activities = {
      readOrder: async (_id: string, mirrored?: string) => ({
        ...state,
        ...(mirrored ? { mirroredDispute: { id: mirrored, resolution: 'decided' } } : {}),
      }),
      resolveObligationDispute: async (...args: unknown[]) => {
        sent.push(args);
        if (!recovered) throw ApplicationFailure.nonRetryable('refused', 'BUSINESS_RULE_VIOLATION');
      },
      noteReleaseUnconfirmed: async (_id: string, round: number) => {
        rounds.push(round);
      },
    } satisfies Partial<OrderActivities>;
    const taskQueue = `rollover-release-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities,
    });
    /** What this run was started with. */
    const resumeOf = async (runId?: string): Promise<SagaResume | undefined> => {
      const history = await env.client.workflow.getHandle(taskQueue, runId).fetchHistory();
      const start = history.events?.[0]?.workflowExecutionStartedEventAttributes;
      const payload = start?.input?.payloads?.[0];
      const input = JSON.parse(Buffer.from(payload?.data as Uint8Array).toString());
      return (input as OrderSagaInput).resume;
    };
    await worker.runUntil(async () => {
      const dueAt = (await env.currentTimeMs()) + 30 * 24 * 60 * 60 * 1000;
      const handle = await env.client.workflow.start(orderSaga, {
        workflowId: taskQueue,
        taskQueue,
        args: [
          {
            ...INPUT,
            recheckIntervalHours: 1,
            resume: {
              status: {
                phase: 'DISPUTED',
                deferredSteps: [],
                remindersRecorded: 0,
                settlementAttempts: 0,
              },
              mirroredDispute: 'DSP_RELEASE',
              mirroredEconomicDispute: 'ECON_RELEASE',
              waitingIn: 'DISPUTED',
              reminderDue: [['FUNDS_HELD', dueAt]],
              activitySequence: 5,
            },
          },
        ],
      });
      const latest = env.client.workflow.getHandle(taskQueue);
      try {
        const first = (await handle.describe()).runId;
        await env.sleep('8 hours');
        const second = (await latest.describe()).runId;
        expect(second).not.toBe(first);
        expect(rounds.length).toBeGreaterThanOrEqual(4);
        // The count goes on across the rollover, so the backoff does not start again.
        expect(rounds).toEqual(rounds.map((_, i) => i + 1));
        expect(await resumeOf(second)).toMatchObject({
          mirroredDispute: 'DSP_RELEASE',
          mirroredEconomicDispute: 'ECON_RELEASE',
          waitingIn: 'FUNDS_HELD',
          reminderDue: [['FUNDS_HELD', dueAt]],
          releaseRounds: expect.any(Number),
        });
        expect(new Set(sent.map((args) => JSON.stringify(args)))).toEqual(
          new Set([
            JSON.stringify([
              INPUT.orderId,
              'TXN_RELEASE',
              'DSP_RELEASE',
              'decided',
              'ECON_RELEASE',
            ]),
          ]),
        );
        expect((await latest.query<SagaStatus>('status')).phase).toBe('RELEASE_UNCONFIRMED');

        recovered = true;
        await atRest(taskQueue);
        await latest.signal('retryDisputeRelease');
        for (let i = 0; i < 100; i++) {
          if ((await latest.query<SagaStatus>('status')).phase === 'AWAITING_CONFIRMATION') break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect((await latest.query<SagaStatus>('status')).phase).toBe('AWAITING_CONFIRMATION');

        // Confirmed: the next ordinary rollover no longer claims a release wait.
        await atRest(taskQueue);
        await env.sleep('12 hours');
        const third = (await latest.describe()).runId;
        expect(third).not.toBe(second);
        const resumed = await resumeOf(third);
        expect(resumed).toBeDefined();
        expect(resumed).not.toHaveProperty('releaseRounds');
        expect(resumed).not.toHaveProperty('mirroredDispute');
        for (const runId of [first, second, third]) {
          await Worker.runReplayHistory(
            { workflowsPath: require.resolve('./workflows') },
            await env.client.workflow.getHandle(taskQueue, runId).fetchHistory(),
            taskQueue,
          );
        }
      } finally {
        await latest.terminate();
      }
    });
  });

  it('a rollover during a dispute does not buy the resumed order a fresh window (D-083)', async () => {
    const dispute = { id: 'DSP_WINDOW', reason: 'not answered', resolution: null as string | null };
    const state: SagaOrderView = {
      status: 'FUNDS_HELD',
      economicTransactionId: 'TXN_WINDOW',
      cancellationReason: null,
      dispute: null,
    };
    let reminders = 0;
    let disputed = 0;
    let released = 0;
    const activities = {
      readOrder: async (_id: string, mirrored?: string) => ({
        ...state,
        ...(mirrored ? { mirroredDispute: { id: mirrored, resolution: dispute.resolution } } : {}),
      }),
      recordReminder: async () => {
        reminders++;
      },
      disputeObligation: async () => {
        disputed++;
        return 'ECON_WINDOW';
      },
      resolveObligationDispute: async () => {
        released++;
      },
    } satisfies Partial<OrderActivities>;
    const taskQueue = `rollover-window-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities,
    });
    await worker.runUntil(async () => {
      // The window: six hours from the start. A fresh one on resuming after
      // about three hours would not be due before nine.
      await env.client.workflow.start(orderSaga, {
        workflowId: taskQueue,
        taskQueue,
        args: [{ ...INPUT, fulfillmentWindowDays: 6 / 24 }],
      });
      const latest = env.client.workflow.getHandle(taskQueue);
      await atRest(taskQueue);
      await env.sleep('65 minutes');

      state.status = 'DISPUTED';
      state.dispute = dispute;
      await latest.signal('orderDisputed', 'ignored');
      await eventually(() => disputed === 1);
      expect(disputed).toBe(1);

      await atRest(taskQueue);
      const disputedRun = (await latest.describe()).runId;
      await env.sleep('125 minutes');
      expect((await latest.describe()).runId).not.toBe(disputedRun);

      dispute.resolution = 'the supplier has answered since';
      state.status = 'FUNDS_HELD';
      state.dispute = null;
      await latest.signal('disputeResolved', 'SETTLE');
      await eventually(() => released === 1);
      expect(released).toBe(1);

      await atRest(taskQueue);
      await env.sleep('155 minutes');
      expect(reminders).toBe(0);
      await env.sleep('20 minutes');
      await eventually(() => reminders === 1);
      expect(reminders).toBe(1);

      const replayed = await latest.fetchHistory();
      await Worker.runReplayHistory(
        { workflowsPath: require.resolve('./workflows') },
        replayed,
        taskQueue,
      );
      // Finished, not terminated: nothing left in flight for the time-skipping server.
      state.status = 'COMPLETED';
      await latest.signal('orderConfirmed');
      await expect(latest.result()).resolves.toBe('COMPLETED');
    });
  }, 300_000);

  it('a run continued before D-083 keeps the deadline its resume carries, not a fresh window', async () => {
    const state: SagaOrderView = {
      status: 'FUNDS_HELD',
      economicTransactionId: 'TXN_SEED',
      cancellationReason: null,
      dispute: null,
    };
    let reminders = 0;
    const activities = {
      readOrder: async () => state,
      recordReminder: async () => {
        reminders++;
      },
    } satisfies Partial<OrderActivities>;
    const taskQueue = `rollover-seed-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities,
    });
    await worker.runUntil(async () => {
      // As #573 wrote it: this wait's deadline, and no `reminderDue`.
      const now = await env.currentTimeMs();
      await env.client.workflow.start(orderSaga, {
        workflowId: taskQueue,
        taskQueue,
        args: [
          {
            ...INPUT,
            historyEventThreshold: 2000,
            recheckIntervalHours: 1,
            fulfillmentWindowDays: 6 / 24,
            reminderIntervalDays: 6 / 24,
            resume: {
              status: {
                phase: 'AWAITING_CONFIRMATION',
                deferredSteps: [],
                remindersRecorded: 0,
                settlementAttempts: 0,
              },
              waitingIn: 'FUNDS_HELD' as const,
              nextReminderAt: now + 2 * 60 * 60_000,
              activitySequence: 1,
            },
          },
        ],
      });
      const latest = env.client.workflow.getHandle(taskQueue);
      await atRest(taskQueue);
      await env.sleep('90 minutes');
      expect(reminders).toBe(0);
      await env.sleep('40 minutes');
      await eventually(() => reminders === 1);
      expect(reminders).toBe(1);

      state.status = 'COMPLETED';
      await latest.signal('orderConfirmed');
      await expect(latest.result()).resolves.toBe('COMPLETED');
    });
  }, 300_000);

  it.each([
    ['in a first run', undefined, 0],
    ['past a passed deadline, in a run continued before D-083', -1, 1],
  ])(
    'a wait entered before the D-083 marker still hands its live deadline to the resumed order: %s',
    async (_case, resumeInHours, remindersBeforeDeadline) => {
      const dir = mkdtempSync(join(__dirname, '.legacy-'));
      const source = readFileSync(require.resolve('./workflows.ts'), 'utf8');
      writeFileSync(
        join(dir, 'workflows.ts'),
        source.replaceAll('patched(DISPUTE_RESUME_PATCH)', 'false'),
      );
      try {
        const dispute = { id: 'DSP_LIVE', reason: 'late', resolution: null as string | null };
        const state: SagaOrderView = {
          status: 'FUNDS_HELD',
          economicTransactionId: 'TXN_LIVE',
          cancellationReason: null,
          dispute: null,
        };
        let reminders = 0;
        let disputed = 0;
        let released = 0;
        const activities = {
          readOrder: async (_id: string, mirrored?: string) => ({
            ...state,
            ...(mirrored
              ? { mirroredDispute: { id: mirrored, resolution: dispute.resolution } }
              : {}),
          }),
          recordReminder: async () => {
            reminders++;
          },
          disputeObligation: async () => {
            disputed++;
            return 'ECON_LIVE';
          },
          resolveObligationDispute: async () => {
            released++;
          },
        } satisfies Partial<OrderActivities>;
        const taskQueue = `rollover-live-${++serial}`;
        const options = {
          connection: env.nativeConnection,
          taskQueue,
          activities,
          maxCachedWorkflows: 0,
        };
        const now = await env.currentTimeMs();
        const input: OrderSagaInput = {
          ...INPUT,
          historyEventThreshold: 2000,
          recheckIntervalHours: 1,
          fulfillmentWindowDays: 6 / 24,
          reminderIntervalDays: 6 / 24,
          ...(resumeInHours === undefined
            ? {}
            : {
                resume: {
                  status: {
                    phase: 'AWAITING_CONFIRMATION',
                    deferredSteps: [],
                    remindersRecorded: 0,
                    settlementAttempts: 0,
                  },
                  waitingIn: 'FUNDS_HELD' as const,
                  nextReminderAt: now + resumeInHours * 60 * 60_000,
                  activitySequence: 1,
                },
              }),
        };
        const before = await Worker.create({
          ...options,
          workflowsPath: join(dir, 'workflows.ts'),
        });
        await before.runUntil(async () => {
          await env.client.workflow.start(orderSaga, {
            workflowId: taskQueue,
            taskQueue,
            args: [input],
          });
          // The passed deadline is met here, before the new worker takes over.
          await atRest(taskQueue);
          const seen = await env.client.workflow.getHandle(taskQueue).query<SagaStatus>('status');
          expect(seen.phase).toBe('AWAITING_CONFIRMATION');
        });
        expect(reminders).toBe(remindersBeforeDeadline);

        const after = await Worker.create({
          ...options,
          workflowsPath: require.resolve('./workflows'),
        });
        await after.runUntil(async () => {
          const latest = env.client.workflow.getHandle(taskQueue);
          state.status = 'DISPUTED';
          state.dispute = dispute;
          await latest.signal('orderDisputed', 'ignored');
          await eventually(() => disputed === 1);
          expect(disputed).toBe(1);
          await atRest(taskQueue);
          await env.sleep('90 minutes');

          dispute.resolution = 'the supplier has answered since';
          state.status = 'FUNDS_HELD';
          state.dispute = null;
          await latest.signal('disputeResolved', 'SETTLE');
          await eventually(() => released === 1);
          expect(released).toBe(1);

          // The live deadline is six hours from the first arming, or from the
          // reminder met above: not behind us, and not six hours from resuming.
          await atRest(taskQueue);
          await env.sleep('240 minutes');
          expect(reminders).toBe(remindersBeforeDeadline);
          await env.sleep('40 minutes');
          await eventually(() => reminders === remindersBeforeDeadline + 1);
          expect(reminders).toBe(remindersBeforeDeadline + 1);

          state.status = 'COMPLETED';
          await latest.signal('orderConfirmed');
          await expect(latest.result()).resolves.toBe('COMPLETED');
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
