import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestWorkflowEnvironment, MockActivityEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import { temporalStep, type OrderActivities, type SagaOrderView } from './activities';
import {
  orderSaga,
  shouldRollSaga,
  SAGA_HISTORY_BYTES,
  SAGA_HISTORY_EVENTS,
  type OrderSagaInput,
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
  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 300_000);
  afterAll(async () => {
    await env?.teardown();
  });

  it('switches a running legacy command stream to the patch and replays its mixed history', async () => {
    // Exercise the legacy branch that the immutable pre-change fixture above
    // independently verifies. Disable patch adoption only for the first worker.
    const dir = mkdtempSync(join(__dirname, '.legacy-'));
    const source = readFileSync(require.resolve('./workflows.ts'), 'utf8');
    writeFileSync(join(dir, 'workflows.ts'), source.replaceAll('patched(ROLLOVER_PATCH)', 'false'));
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
});
