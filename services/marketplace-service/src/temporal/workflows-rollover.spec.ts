import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { createTemporalTestEnvironment } from '../../test/temporal-environment';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockActivityEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { FINAL_ANSWER_CONTRACT, REFUSED_ON_FIRST_ATTEMPT } from './economic-refusal';
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
    env = await createTemporalTestEnvironment();
  }, 300_000);
  afterAll(async () => {
    await env?.teardown();
  });

  it('switches a running legacy command stream to the patch and replays its mixed history', async () => {
    // Exercise the legacy branch that the immutable pre-change fixture above
    // independently verifies. Disable patch adoption only for the first worker:
    // it stands for a release before both markers, so it records neither.
    const dir = mkdtempSync(join(__dirname, '.legacy-'));
    const source = readFileSync(require.resolve('./workflows.ts'), 'utf8').replaceAll(
      "'./economic-refusal'",
      "'../economic-refusal'",
    );
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
          [INPUT.orderId, 'TXN_ROLL', 'DSP_OLD', 'old decision', 'ECON_OLD', FINAL_ANSWER_CONTRACT],
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
              FINAL_ANSWER_CONTRACT,
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

  it('rolls over inside the wait of an authorisation; confirmed, the next rollover no longer claims it (FU-103)', async () => {
    // Found mid-settlement, so a round must not take it for an order moved on.
    const state: SagaOrderView = {
      status: 'SETTLING',
      economicTransactionId: 'TXN_AUTH',
      cancellationReason: null,
      dispute: null,
    };
    const sent: unknown[][] = [];
    const rounds: number[] = [];
    let recovered = false;
    const taskQueue = `rollover-authorise-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities: {
        readOrder: async () => state,
        authoriseSettlement: async (...args: unknown[]) => {
          sent.push(args);
          if (!recovered) throw ApplicationFailure.retryable('down', 'UPSTREAM_UNAVAILABLE');
          return undefined;
        },
        noteEconomicCallUnconfirmed: async (_id: string, _op: string, round: number) => {
          rounds.push(round);
        },
        // Disputed just as it could settle: the saga then waits, and rolls over there.
        markSettling: async () => {
          state.status = 'DISPUTED';
          state.dispute = { id: 'DSP_AUTH', reason: 'broken', resolution: null };
          return 'DISPUTED';
        },
        disputeObligation: async () => 'ECON_AUTH',
      } as unknown as Partial<OrderActivities>,
    });
    const resumeOf = async (runId: string): Promise<SagaResume | undefined> => {
      const history = await env.client.workflow.getHandle(taskQueue, runId).fetchHistory();
      const start = history.events?.[0]?.workflowExecutionStartedEventAttributes;
      const data = start?.input?.payloads?.[0]?.data as Uint8Array;
      return (JSON.parse(Buffer.from(data).toString()) as OrderSagaInput).resume;
    };
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        workflowId: taskQueue,
        taskQueue,
        args: [
          {
            ...INPUT,
            recheckIntervalHours: 1,
            resume: {
              status: {
                phase: 'SETTLING',
                deferredSteps: [],
                remindersRecorded: 0,
                settlementAttempts: 0,
              },
              waitingIn: 'RECEIPT_CONFIRMED',
              activitySequence: 5,
            },
          },
        ],
      });
      const latest = env.client.workflow.getHandle(taskQueue);
      try {
        const first = (await handle.describe()).runId;
        await eventually(() => rounds.length > 0);
        await atRest(taskQueue);
        await env.sleep('8 hours');
        const second = (await latest.describe()).runId;
        expect(second).not.toBe(first);
        // The count goes on across the rollover, so the backoff does not start again.
        expect(rounds.length).toBeGreaterThanOrEqual(4);
        expect(rounds).toEqual(rounds.map((_, i) => i + 1));
        expect(await resumeOf(second)).toMatchObject({
          unconfirmedCall: { operation: 'authoriseSettlement', rounds: expect.any(Number) },
        });
        // The same words, so the same key; each round adds only that it is in doubt.
        expect(new Set(sent.map((args) => JSON.stringify(args.slice(0, 2))))).toEqual(
          new Set([JSON.stringify([INPUT.orderId, 'TXN_AUTH'])]),
        );
        expect(sent.at(-1)?.[2]).toBe(true);
        expect((await latest.query<SagaStatus>('status')).phase).toBe('AUTHORISATION_UNCONFIRMED');

        await atRest(taskQueue);
        recovered = true;
        await latest.signal('retryDisputeRelease');
        await eventually(() => state.status === 'DISPUTED');
        await atRest(taskQueue);
        await env.sleep('12 hours');
        const third = (await latest.describe()).runId;
        expect(third).not.toBe(second);
        const resumed = await resumeOf(third);
        expect(resumed).toMatchObject({ mirroredDispute: 'DSP_AUTH' });
        expect(resumed).not.toHaveProperty('unconfirmedCall');
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

  it('answered at the first call of the next run: the claim ends there (FU-103)', async () => {
    const state: SagaOrderView = {
      status: 'RECEIPT_CONFIRMED',
      economicTransactionId: 'TXN_NEXT',
      cancellationReason: null,
      dispute: null,
    };
    const taskQueue = `rollover-next-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities: {
        readOrder: async () => state,
        authoriseSettlement: async () => undefined,
        markSettling: async () => {
          state.status = 'DISPUTED';
          state.dispute = { id: 'DSP_NEXT', reason: 'broken', resolution: null };
          return 'DISPUTED';
        },
        disputeObligation: async () => 'ECON_NEXT',
      } as unknown as Partial<OrderActivities>,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        workflowId: taskQueue,
        taskQueue,
        args: [
          {
            ...INPUT,
            recheckIntervalHours: 1,
            resume: {
              status: {
                phase: 'AUTHORISATION_UNCONFIRMED',
                deferredSteps: [],
                remindersRecorded: 0,
                settlementAttempts: 0,
              },
              waitingIn: 'RECEIPT_CONFIRMED',
              activitySequence: 5,
              unconfirmedCall: { operation: 'authoriseSettlement', rounds: 3 },
            },
          },
        ],
      });
      const latest = env.client.workflow.getHandle(taskQueue);
      try {
        const first = (await handle.describe()).runId;
        await eventually(() => state.status === 'DISPUTED');
        await atRest(taskQueue);
        await env.sleep('12 hours');
        const next = (await latest.describe()).runId;
        expect(next).not.toBe(first);
        const history = await latest.fetchHistory();
        const start = history.events?.[0]?.workflowExecutionStartedEventAttributes;
        const data = start?.input?.payloads?.[0]?.data as Uint8Array;
        const resumed = (JSON.parse(Buffer.from(data).toString()) as OrderSagaInput).resume;
        expect(resumed).not.toHaveProperty('unconfirmedCall');
        await atRest(taskQueue);
      } finally {
        await latest.terminate();
      }
    });
  });

  it('rolled over in that wait with the order moved on: the next run does not follow it until economic-service answers (FU-103)', async () => {
    const state: SagaOrderView = {
      status: 'RECEIPT_CONFIRMED',
      economicTransactionId: 'TXN_MOVED',
      cancellationReason: null,
      dispute: null,
    };
    const filed: unknown[][] = [];
    const rounds: number[] = [];
    let recovered = false;
    let sends = 0;
    const down = () => ApplicationFailure.retryable('down', 'UPSTREAM_UNAVAILABLE');
    const taskQueue = `rollover-moved-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities: {
        readOrder: async () => state,
        authoriseSettlement: async () => {
          sends += 1;
          throw down();
        },
        findObligation: async () => {
          if (!recovered) throw down();
          return { transactionId: 'TXN_MOVED' };
        },
        noteEconomicCallUnconfirmed: async (_id: string, _op: string, round: number) => {
          rounds.push(round);
        },
        disputeObligation: async (...args: unknown[]) => {
          filed.push(args);
          return 'ECON_MOVED';
        },
      } as unknown as Partial<OrderActivities>,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        workflowId: taskQueue,
        taskQueue,
        args: [
          {
            ...INPUT,
            recheckIntervalHours: 1,
            resume: {
              status: {
                phase: 'SETTLING',
                deferredSteps: [],
                remindersRecorded: 0,
                settlementAttempts: 0,
              },
              waitingIn: 'RECEIPT_CONFIRMED',
              activitySequence: 5,
            },
          },
        ],
      });
      const latest = env.client.workflow.getHandle(taskQueue);
      try {
        const first = (await handle.describe()).runId;
        await eventually(() => rounds.length > 0);
        await atRest(taskQueue);
        state.status = 'DISPUTED';
        state.dispute = { id: 'DSP_MOVED', reason: 'broken', resolution: null };
        const sent = sends;
        await env.sleep('8 hours');
        expect((await latest.describe()).runId).not.toBe(first);
        expect(sends).toBe(sent);
        expect(filed).toEqual([]);
        expect((await latest.query<SagaStatus>('status')).phase).toBe('AUTHORISATION_UNCONFIRMED');

        await atRest(taskQueue);
        recovered = true;
        await latest.signal('retryDisputeRelease');
        await eventually(() => filed.length > 0);
        // With the authorisation still in doubt, the filing goes as in doubt too.
        expect(filed).toEqual([
          [INPUT.orderId, 'TXN_MOVED', 'DSP_MOVED', 'broken', true, FINAL_ANSWER_CONTRACT],
        ]);
        // Rolled over in the dispute's wait, the next run knows the call is still
        // in doubt, and that it left the wait.
        await atRest(taskQueue);
        const beforeDispute = (await latest.describe()).runId;
        await env.sleep('8 hours');
        const { runId } = await latest.describe();
        expect(runId).not.toBe(beforeDispute);
        const history = await env.client.workflow.getHandle(taskQueue, runId).fetchHistory();
        const data = history.events?.[0]?.workflowExecutionStartedEventAttributes?.input
          ?.payloads?.[0]?.data as Uint8Array;
        expect((JSON.parse(Buffer.from(data).toString()) as OrderSagaInput).resume).toMatchObject({
          unconfirmedCall: { operation: 'authoriseSettlement', movedOn: true },
        });
        // A terminated activity would stall the server's clock for the next test.
        await atRest(taskQueue);
      } finally {
        await latest.terminate();
      }
    });
  });

  it('a run resumed after leaving that wait does not go back to it, and is still in doubt on its way back (FU-103)', async () => {
    const state: SagaOrderView = {
      status: 'DISPUTED',
      economicTransactionId: 'TXN_LEFT',
      cancellationReason: null,
      dispute: { id: 'DSP_LEFT', reason: 'broken', resolution: null },
    };
    const sent: unknown[][] = [];
    const rounds: number[] = [];
    let asked = 0;
    let filed = 0;
    const taskQueue = `rollover-left-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities: {
        readOrder: async () => state,
        findObligation: async () => {
          asked += 1;
          return { transactionId: 'TXN_LEFT' };
        },
        disputeObligation: async () => {
          filed += 1;
          return 'ECON_LEFT';
        },
        resolveObligationDispute: async () => undefined,
        authoriseSettlement: async (...args: unknown[]) => {
          sent.push(args);
          // Even marked as a first attempt's, which a real round's activity never is.
          throw ApplicationFailure.create({
            message: 'refused',
            type: 'FORBIDDEN',
            nonRetryable: true,
            details: [REFUSED_ON_FIRST_ATTEMPT],
          });
        },
        noteEconomicCallUnconfirmed: async (_id: string, _op: string, round: number) => {
          rounds.push(round);
        },
        markSettling: async () => 'DISPUTED',
      } as unknown as Partial<OrderActivities>,
    });
    await worker.runUntil(async () => {
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
              waitingIn: 'DISPUTED',
              activitySequence: 5,
              unconfirmedCall: { operation: 'authoriseSettlement', rounds: 3, movedOn: true },
            },
          },
        ],
      });
      try {
        await eventually(() => filed > 0);
        expect(asked).toBe(0);
        await atRest(taskQueue);

        state.status = 'RECEIPT_CONFIRMED';
        state.dispute = null;
        await handle.signal('disputeResolved', 'SETTLE');
        await eventually(() => rounds.length > 0);
        expect(rounds[0]).toBe(4);
        expect(sent[0]).toEqual([INPUT.orderId, 'TXN_LEFT', true, FINAL_ANSWER_CONTRACT]);
        expect((await handle.query<SagaStatus>('status')).phase).toBe('AUTHORISATION_UNCONFIRMED');
        await atRest(taskQueue);
      } finally {
        await handle.terminate();
      }
    });
  });

  describe.each([
    {
      name: 'the refund',
      operation: 'compensate',
      // Recorded on no order: only the carried transaction says what to refund.
      state: { status: 'CANCELLING', economicTransactionId: null, cancellationReason: 'why' },
      carried: { transactionId: 'TXN_CARRIED' },
      phase: 'COMPENSATION_UNCONFIRMED',
      sent: [INPUT.orderId, 'TXN_CARRIED', 'why', true, FINAL_ANSWER_CONTRACT],
      done: 'CANCELLED',
    },
    {
      name: 'the filing',
      operation: 'disputeObligation',
      state: {
        status: 'CANCELLING',
        economicTransactionId: 'TXN_CARRIED',
        cancellationReason: 'why',
      },
      carried: { transactionId: 'TXN_CARRIED', disputeId: 'DSP_CARRIED', reason: 'its words' },
      phase: 'DISPUTE_UNCONFIRMED',
      sent: [INPUT.orderId, 'TXN_CARRIED', 'DSP_CARRIED', 'its words', true, FINAL_ANSWER_CONTRACT],
      done: 'CANCELLED',
    },
  ] as const)('$name, resumed in its wait (FU-117)', (site) => {
    it('goes on counting from what the last run carried, first of all, and ends on its answer', async () => {
      const state: SagaOrderView = { ...site.state, dispute: null };
      const sent: unknown[][] = [];
      const rounds: number[] = [];
      const calls: string[] = [];
      let recovered = false;
      const taskQueue = `rollover-${site.operation}-${++serial}`;
      const send = async (...args: unknown[]) => {
        calls.push(site.operation);
        sent.push(args);
        if (!recovered) throw ApplicationFailure.retryable('down', 'UPSTREAM_UNAVAILABLE');
        return 'E';
      };
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath: require.resolve('./workflows'),
        activities: {
          readOrder: async () => {
            calls.push('readOrder');
            return state;
          },
          disputeObligation: send,
          compensate: send,
          findObligation: async () => {
            calls.push('findObligation');
            return null;
          },
          resolveObligationDispute: async () => undefined,
          noteEconomicCallUnconfirmed: async (_id: string, _op: string, round: number) => {
            rounds.push(round);
          },
          markCancelled: async () => {
            state.status = 'CANCELLED';
            return 'CANCELLED';
          },
        } as unknown as Partial<OrderActivities>,
      });
      await worker.runUntil(async () => {
        const handle = await env.client.workflow.start(orderSaga, {
          workflowId: taskQueue,
          taskQueue,
          args: [
            {
              ...INPUT,
              recheckIntervalHours: 1,
              resume: {
                status: {
                  phase: 'WAS',
                  deferredSteps: [],
                  remindersRecorded: 0,
                  settlementAttempts: 0,
                },
                waitingIn: state.status,
                activitySequence: 7,
                siblingCall: { operation: site.operation, rounds: 4, ...site.carried },
              },
            },
          ],
        });
        try {
          await eventually(() => rounds.length > 0);
          expect(rounds[0]).toBe(5);
          expect((await handle.query<SagaStatus>('status')).phase).toBe(site.phase);
          expect(sent[0]).toEqual(site.sent);
          expect(calls).not.toContain('findObligation');
          if (site.operation === 'disputeObligation') expect(calls[0]).toBe(site.operation);
          await atRest(taskQueue);
          recovered = true;
          await handle.signal('retryDisputeRelease');
          expect(await handle.result()).toBe(site.done);
        } finally {
          await handle.terminate().catch(() => undefined);
        }
      });
    });
  });

  it('rolls over inside the hold’s wait under its own field, the buyer cancelling meanwhile (FU-117)', async () => {
    const state: SagaOrderView = {
      status: 'PENDING',
      economicTransactionId: null,
      cancellationReason: null,
      dispute: null,
    };
    const sent: unknown[][] = [];
    const rounds: number[] = [];
    const refunded: unknown[][] = [];
    let recovered = false;
    const taskQueue = `rollover-hold-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities: {
        readOrder: async () => state,
        createObligation: async (...args: unknown[]) => {
          sent.push(args);
          if (!recovered) throw ApplicationFailure.retryable('down', 'UPSTREAM_UNAVAILABLE');
          return { transactionId: 'TXN_HELD' };
        },
        findObligation: async () => null,
        noteEconomicCallUnconfirmed: async (_id: string, _op: string, round: number) => {
          rounds.push(round);
        },
        markFundsHeld: async (_id: string, transactionId: string) => {
          state.economicTransactionId = transactionId;
          return state.status;
        },
        markFailed: async () => {
          throw new Error('a hold in doubt must not fail the order');
        },
        compensate: async (...args: unknown[]) => {
          refunded.push(args);
        },
        markCancelled: async () => 'CANCELLED',
      } as unknown as Partial<OrderActivities>,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        workflowId: taskQueue,
        taskQueue,
        args: [{ ...INPUT, recheckIntervalHours: 1 }],
      });
      const latest = env.client.workflow.getHandle(taskQueue);
      try {
        const first = (await handle.describe()).runId;
        await eventually(() => rounds.length > 0);
        await atRest(taskQueue);
        await env.sleep('8 hours');
        const second = (await latest.describe()).runId;
        expect(second).not.toBe(first);
        expect(rounds).toEqual(rounds.map((_, i) => i + 1));
        const history = await env.client.workflow.getHandle(taskQueue, second).fetchHistory();
        const started = history.events?.[0]?.workflowExecutionStartedEventAttributes;
        const data = started?.input?.payloads?.[0]?.data as Uint8Array;
        const { resume } = JSON.parse(Buffer.from(data).toString()) as OrderSagaInput;
        expect(resume?.holdCall).toEqual({
          rounds: expect.any(Number),
          doubtAt: expect.any(Number),
        });
        expect(resume?.waitingIn).toBe('PENDING');
        expect(resume).not.toHaveProperty('siblingCall');
        expect((await latest.query<SagaStatus>('status')).phase).toBe('HOLD_UNCONFIRMED');
        expect(new Set(sent.map((args) => JSON.stringify(args))).size).toBe(1);

        // Sent on though the order left PENDING: the answer fences a late request off.
        await atRest(taskQueue);
        state.status = 'CANCELLING';
        state.cancellationReason = 'why';
        recovered = true;
        await latest.signal('retryDisputeRelease');
        expect(await latest.result()).toBe('CANCELLED');
        expect(refunded[0]?.slice(0, 2)).toEqual([INPUT.orderId, 'TXN_HELD']);
        for (const runId of [first, second]) {
          await Worker.runReplayHistory(
            { workflowsPath: require.resolve('./workflows') },
            await env.client.workflow.getHandle(taskQueue, runId).fetchHistory(),
            taskQueue,
          );
        }
      } finally {
        await handle.terminate().catch(() => undefined);
      }
    });
  });

  it('a run resumed with the hold in doubt sends first and goes on counting, whatever the order is (FU-117)', async () => {
    const rounds: number[] = [];
    let sends = 0;
    const taskQueue = `rollover-hold-resumed-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities: {
        readOrder: async () => ({
          status: 'CANCELLING',
          economicTransactionId: null,
          cancellationReason: 'why',
          dispute: null,
        }),
        createObligation: async () => {
          sends += 1;
          throw ApplicationFailure.nonRetryable('no', 'INSUFFICIENT_BALANCE');
        },
        findObligation: async () => null,
        noteEconomicCallUnconfirmed: async (_id: string, _op: string, round: number) => {
          rounds.push(round);
        },
        markCancelled: async () => {
          throw new Error('the hold is still in doubt');
        },
        compensate: async () => {
          throw new Error('nothing to refund yet');
        },
      } as unknown as Partial<OrderActivities>,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        workflowId: taskQueue,
        taskQueue,
        args: [
          {
            ...INPUT,
            recheckIntervalHours: 1,
            resume: {
              status: {
                phase: 'WAS',
                deferredSteps: [],
                remindersRecorded: 0,
                settlementAttempts: 0,
              },
              waitingIn: 'PENDING',
              activitySequence: 7,
              holdCall: { rounds: 4 },
            },
          },
        ],
      });
      try {
        await eventually(() => rounds.length > 0);
        expect(rounds[0]).toBe(5);
        expect(sends).toBe(1);
        expect((await handle.query<SagaStatus>('status')).phase).toBe('HOLD_UNCONFIRMED');
      } finally {
        await handle.terminate().catch(() => undefined);
      }
    });
  });

  it.each([
    {
      name: 'the refund, of a transaction only the lookup knew',
      operation: 'compensate',
      phase: 'COMPENSATION_UNCONFIRMED',
      state: { status: 'CANCELLING', economicTransactionId: null, cancellationReason: 'why' },
      carried: { transactionId: 'TXN_FOUND' },
      words: [INPUT.orderId, 'TXN_FOUND', 'why'],
    },
    {
      name: 'the filing, decided meanwhile',
      operation: 'disputeObligation',
      phase: 'DISPUTE_UNCONFIRMED',
      state: {
        status: 'DISPUTED',
        economicTransactionId: 'TXN_FOUND',
        cancellationReason: null,
        dispute: { id: 'DSP_R', reason: 'its words', resolution: null },
      },
      carried: { transactionId: 'TXN_FOUND', disputeId: 'DSP_R', reason: 'its words' },
      words: [INPUT.orderId, 'TXN_FOUND', 'DSP_R', 'its words'],
    },
  ] as const)('rolls over inside the wait of $name (FU-117)', async (site) => {
    const state = { dispute: null, ...site.state } as SagaOrderView;
    const sent: unknown[][] = [];
    const rounds: number[] = [];
    const released: unknown[][] = [];
    let lookups = 0;
    let recovered = false;
    const taskQueue = `rollover-real-${site.operation}-${++serial}`;
    const send = async (...args: unknown[]) => {
      sent.push(args);
      if (!recovered) throw ApplicationFailure.retryable('down', 'UPSTREAM_UNAVAILABLE');
      return 'ECON_R';
    };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities: {
        readOrder: async () => state,
        findObligation: async () => {
          lookups += 1;
          return { transactionId: 'TXN_FOUND' };
        },
        compensate: site.operation === 'compensate' ? send : async () => undefined,
        disputeObligation: site.operation === 'disputeObligation' ? send : async () => 'ECON_R',
        resolveObligationDispute: async (...args: unknown[]) => {
          released.push(args);
        },
        noteEconomicCallUnconfirmed: async (_id: string, _op: string, round: number) => {
          rounds.push(round);
        },
        markCancelled: async () => 'CANCELLED',
      } as unknown as Partial<OrderActivities>,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        workflowId: taskQueue,
        taskQueue,
        args: [
          {
            ...INPUT,
            recheckIntervalHours: 1,
            resume: {
              status: {
                phase: 'WAS',
                deferredSteps: [],
                remindersRecorded: 0,
                settlementAttempts: 0,
              },
              waitingIn: state.status,
              activitySequence: 5,
            },
          },
        ],
      });
      const latest = env.client.workflow.getHandle(taskQueue);
      try {
        const first = (await handle.describe()).runId;
        await eventually(() => rounds.length > 0);
        await atRest(taskQueue);
        await env.sleep('8 hours');
        const second = (await latest.describe()).runId;
        expect(second).not.toBe(first);
        expect(rounds).toEqual(rounds.map((_, i) => i + 1));
        const history = await env.client.workflow.getHandle(taskQueue, second).fetchHistory();
        const started = history.events?.[0]?.workflowExecutionStartedEventAttributes;
        const data = started?.input?.payloads?.[0]?.data as Uint8Array;
        expect((JSON.parse(Buffer.from(data).toString()) as OrderSagaInput).resume).toMatchObject({
          waitingIn: state.status,
          siblingCall: { operation: site.operation, rounds: expect.any(Number), ...site.carried },
        });
        expect((await latest.query<SagaStatus>('status')).phase).toBe(site.phase);
        // The same words, so the same key, across the runs.
        const words = sent.map((args) =>
          JSON.stringify(args.filter((arg) => typeof arg !== 'boolean')),
        );
        expect(new Set(words)).toEqual(
          new Set([JSON.stringify([...site.words, FINAL_ANSWER_CONTRACT])]),
        );
        expect(sent.at(-1)?.at(-2)).toBe(true);

        await atRest(taskQueue);
        state.status = 'CANCELLING';
        state.cancellationReason = 'why';
        state.dispute = null;
        recovered = true;
        await latest.signal('retryDisputeRelease');
        expect(await latest.result()).toBe('CANCELLED');
        if (site.operation === 'compensate') expect(lookups).toBe(1);
        // What the filing answered is what the release names.
        else expect(released[0]?.slice(0, 3)).toEqual([INPUT.orderId, 'TXN_FOUND', 'DSP_R']);
        if (site.operation !== 'compensate') expect(released[0]?.[4]).toBe('ECON_R');
        for (const runId of [first, second]) {
          await Worker.runReplayHistory(
            { workflowsPath: require.resolve('./workflows') },
            await env.client.workflow.getHandle(taskQueue, runId).fetchHistory(),
            taskQueue,
          );
        }
      } finally {
        await latest.terminate().catch(() => undefined);
      }
    });
  });

  it('a resumed refund whose order read is refused stays in its wait (FU-117)', async () => {
    const state: SagaOrderView = {
      status: 'CANCELLING',
      economicTransactionId: 'TXN_READ',
      cancellationReason: 'why',
      dispute: null,
    };
    const rounds: number[] = [];
    const sent: unknown[][] = [];
    let readable = false;
    const taskQueue = `rollover-read-sibling-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities: {
        readOrder: async () => {
          if (!readable) throw ApplicationFailure.nonRetryable('refused', 'NOT_FOUND');
          return state;
        },
        compensate: async (...args: unknown[]) => {
          sent.push(args);
        },
        noteEconomicCallUnconfirmed: async (_id: string, _op: string, round: number) => {
          rounds.push(round);
        },
        markCancelled: async () => 'CANCELLED',
      } as unknown as Partial<OrderActivities>,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        workflowId: taskQueue,
        taskQueue,
        args: [
          {
            ...INPUT,
            recheckIntervalHours: 1,
            resume: {
              status: {
                phase: 'WAS',
                deferredSteps: [],
                remindersRecorded: 0,
                settlementAttempts: 0,
              },
              waitingIn: 'CANCELLING',
              activitySequence: 5,
              siblingCall: { operation: 'compensate', rounds: 2, transactionId: 'TXN_READ' },
            },
          },
        ],
      });
      await eventually(() => rounds.length > 0);
      expect(rounds[0]).toBe(3);
      expect(sent).toEqual([]);
      expect((await handle.query<SagaStatus>('status')).phase).toBe('COMPENSATION_UNCONFIRMED');
      await atRest(taskQueue);
      readable = true;
      await handle.signal('retryDisputeRelease');
      expect(await handle.result()).toBe('CANCELLED');
      expect(sent).toEqual([[INPUT.orderId, 'TXN_READ', 'why', true, FINAL_ANSWER_CONTRACT]]);
    });
  });

  it('a resumed run at PENDING with no hold in doubt still refuses (FU-117)', async () => {
    const taskQueue = `rollover-pending-${++serial}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities: {
        readOrder: async () => ({
          status: 'PENDING',
          economicTransactionId: null,
          cancellationReason: null,
          dispute: null,
        }),
      } as unknown as Partial<OrderActivities>,
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
                phase: 'WAS',
                deferredSteps: [],
                remindersRecorded: 0,
                settlementAttempts: 0,
              },
              waitingIn: 'PENDING',
              activitySequence: 3,
              siblingCall: { operation: 'compensate', rounds: 1, transactionId: 'T' },
            },
          },
        ],
      });
      await expect(handle.result()).rejects.toMatchObject({
        cause: { type: 'SAGA_INCONSISTENT' },
      });
    });
  });

  it.each([
    ['in that wait', false, 'RECEIPT_CONFIRMED'],
    ['after leaving it for a dispute', true, 'DISPUTED'],
  ] as const)(
    'a resumed run whose order read is refused, %s: the call is unconfirmed, so the saga stays (FU-103)',
    async (_name, movedOn, orderStatus) => {
      const state: SagaOrderView = {
        status: orderStatus,
        economicTransactionId: 'TXN_READ',
        cancellationReason: null,
        dispute: movedOn ? { id: 'DSP_READ', reason: 'broken', resolution: null } : null,
      };
      const rounds: number[] = [];
      let readable = false;
      const went: string[] = [];
      const taskQueue = `rollover-read-${++serial}`;
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath: require.resolve('./workflows'),
        activities: {
          readOrder: async () => {
            if (!readable) throw ApplicationFailure.nonRetryable('refused', 'NOT_FOUND');
            return state;
          },
          authoriseSettlement: async () => {
            went.push('authoriseSettlement');
            throw ApplicationFailure.retryable('down', 'UPSTREAM_UNAVAILABLE');
          },
          disputeObligation: async () => {
            went.push('disputeObligation');
            return 'ECON_READ';
          },
          noteEconomicCallUnconfirmed: async (_id: string, _op: string, round: number) => {
            rounds.push(round);
          },
        } as unknown as Partial<OrderActivities>,
      });
      await worker.runUntil(async () => {
        const handle = await env.client.workflow.start(orderSaga, {
          workflowId: taskQueue,
          taskQueue,
          args: [
            {
              ...INPUT,
              recheckIntervalHours: 1,
              resume: {
                status: {
                  phase: 'SETTLING',
                  deferredSteps: [],
                  remindersRecorded: 0,
                  settlementAttempts: 0,
                },
                waitingIn: orderStatus,
                activitySequence: 5,
                unconfirmedCall: { operation: 'authoriseSettlement', rounds: 2, movedOn },
              },
            },
          ],
        });
        try {
          await eventually(() => rounds.length > 0);
          expect(rounds[0]).toBe(3);
          expect(went).toEqual([]);
          expect((await handle.query<SagaStatus>('status')).phase).toBe(
            'AUTHORISATION_UNCONFIRMED',
          );
          await atRest(taskQueue);
          readable = true;
          await handle.signal('retryDisputeRelease');
          await eventually(() => went.length > 0);
          expect(went[0]).toBe(movedOn ? 'disputeObligation' : 'authoriseSettlement');
          await atRest(taskQueue);
        } finally {
          await handle.terminate();
        }
      });
    },
  );

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
      const source = readFileSync(require.resolve('./workflows.ts'), 'utf8').replaceAll(
        "'./economic-refusal'",
        "'../economic-refusal'",
      );
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
          // At rest can mean the task that scheduled the reminder has just completed.
          await eventually(() => reminders === remindersBeforeDeadline);
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
