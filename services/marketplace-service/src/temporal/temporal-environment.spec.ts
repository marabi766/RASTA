import { AsyncLocalStorage } from 'node:async_hooks';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import type { CallContext, Connection, WorkflowQueryInput } from '@temporalio/client';
import {
  boundedQueries,
  createTemporalTestEnvironment,
  QUERY_ATTEMPTS,
} from '../../test/temporal-environment';
import { orderSaga, retryDisputeRelease, type SagaStatus } from './workflows';
import { REFUSED_ON_FIRST_ATTEMPT } from './economic-refusal';
import type { OrderActivities } from './activities';

/**
 * The shared Temporal test environment answers a query that reaches a saga as it
 * continues as new. The time-skipping server leaves such a query unanswered; with no
 * deadline it hung the spec past its timeout in CI (#935, run 42391595495).
 */

jest.setTimeout(240_000);

const grpcError = (code: number) =>
  Object.assign(new Error(`${code} grpc`), { code, details: 'grpc', metadata: {} });
const INPUT = {} as WorkflowQueryInput;
/** The SDK's call context, as `Connection` keeps it: a deadline replaces, the rest stays. */
const callContextStorage = new AsyncLocalStorage<CallContext>();
const connection = {
  callContextStorage,
  withDeadline: (deadline: number | Date, fn: () => Promise<unknown>) =>
    callContextStorage.run({ ...callContextStorage.getStore(), deadline }, fn),
} as unknown as Connection;
const asCaller = <T>(context: CallContext, fn: () => Promise<T>) =>
  callContextStorage.run(context, fn);

describe('a query through the Temporal test environment', () => {
  describe('asks again only on a deadline or a cancelled call, never past the caller', () => {
    const query = boundedQueries(() => connection).query!;

    it('answers on a later attempt after a deadline and a cancelled call', async () => {
      const next = jest
        .fn()
        .mockRejectedValueOnce(grpcError(4))
        .mockRejectedValueOnce(grpcError(1))
        .mockResolvedValueOnce('answer');
      await expect(query(INPUT, next)).resolves.toBe('answer');
      expect(next).toHaveBeenCalledTimes(3);
    });

    it('throws any other failure at once', async () => {
      const next = jest.fn().mockRejectedValue(grpcError(5));
      await expect(query(INPUT, next)).rejects.toThrow('5 grpc');
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('fails, named, once no attempt is answered', async () => {
      const next = jest.fn().mockRejectedValue(grpcError(4));
      const input = { queryType: 'status', workflowExecution: { workflowId: 'W' } };
      await expect(query(input as WorkflowQueryInput, next)).rejects.toThrow(
        `query status on W answered none of ${QUERY_ATTEMPTS} attempts`,
      );
      expect(next).toHaveBeenCalledTimes(QUERY_ATTEMPTS);
    });

    it("throws the caller's abort as it came, never asked again", async () => {
      const abort = new AbortController();
      abort.abort();
      const next = jest.fn().mockRejectedValue(grpcError(1));
      await expect(
        asCaller({ abortSignal: abort.signal }, () => query(INPUT, next)),
      ).rejects.toThrow('1 grpc');
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("throws past the caller's deadline as it came, never asked again", async () => {
      const next = jest.fn().mockRejectedValue(grpcError(4));
      await expect(
        asCaller({ deadline: Date.now() - 1 }, () => query(INPUT, next)),
      ).rejects.toThrow('4 grpc');
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("never gives an attempt longer than the caller's deadline", async () => {
      const callerDeadline = Date.now() + 1_000;
      let seen: number | Date | undefined;
      const next = jest.fn(async () => {
        seen = callContextStorage.getStore()?.deadline;
        return 'answer';
      });
      await asCaller({ deadline: callerDeadline }, () => query(INPUT, next));
      expect(seen).toBe(callerDeadline);
      await query(INPUT, next);
      expect(Number(seen)).toBeGreaterThan(callerDeadline);
    });
  });

  describe('against the test server', () => {
    let env: TestWorkflowEnvironment;
    let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
    beforeAll(async () => {
      workflowBundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') });
      env = await createTemporalTestEnvironment();
    }, 300_000);
    afterAll(async () => {
      await env?.teardown();
    });

    it('is answered when it reaches a saga in the task that rolls it over', async () => {
      const id = 'query-across-rollover';
      const latest = () => env.client.workflow.getHandle(id);
      const queries: Promise<string>[] = [];
      const order = { status: 'DISPUTED', economicTransactionId: 'TXN', cancellationReason: null };
      const dispute = { id: 'DSP_1', reason: 'it arrived broken', resolution: null };
      const refused = () =>
        // A refusal on the first attempt with the money held: the saga waits, and each
        // round it is nudged it calls, reports, and past 16 events rolls over.
        Promise.reject(
          ApplicationFailure.create({
            message: 'refused',
            type: 'FORBIDDEN',
            nonRetryable: true,
            details: [REFUSED_ON_FIRST_ATTEMPT],
          }),
        );
      const reported = () => {
        // The report is the last step before the rollover: a query sent just after it
        // reaches the task that continues the saga as new.
        setTimeout(() => {
          queries.push(
            latest()
              .query<SagaStatus, []>('status')
              .then((status) => status.phase),
          );
        }, 2);
      };
      const stub: Record<string, () => unknown> = {
        readOrder: () => ({ ...order, dispute }),
        findObligation: () => ({ transactionId: 'TXN' }),
        noHoldCanLand: () => true,
        disputeObligation: refused,
        noteEconomicCallUnconfirmed: reported,
        markObligationDisputed: () => ({
          status: 'DISPUTED',
          disputeId: null,
          economicDisputeId: null,
        }),
      };
      // Every other step is never reached on this path, and answers the order's status.
      const names = [
        'authoriseSettlement',
        'settle',
        'resolveObligationDispute',
        'compensate',
        'recordReminder',
        'markSettling',
        'markSettlementFailed',
        'markCompleted',
        'markCancelled',
        'markFundsHeld',
        'markFailed',
        'createObligation',
        'noteReleaseUnconfirmed',
      ];
      const activities = Object.fromEntries([
        ...names.map((name) => [name, async () => 'DISPUTED']),
        ...Object.entries(stub).map(([name, fn]) => [name, async () => fn()]),
      ]) as unknown as OrderActivities;
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: id,
        workflowBundle,
        activities,
      });
      const outcome = await worker.runUntil(async () => {
        const handle = await env.client.workflow.start(orderSaga, {
          taskQueue: id,
          workflowId: id,
          args: [
            {
              orderId: 'ORD_ROLL',
              fulfillmentWindowDays: 7,
              receiptWindowDays: 3,
              reminderIntervalDays: 3,
              recheckIntervalHours: 24 * 365,
              historyEventThreshold: 16,
            },
          ],
        });
        const runs = new Set<string>([handle.firstExecutionRunId]);
        // Nudged only at rest, as the specs do: the test server fails a workflow task a
        // signal reaches while it runs, so a faster nudge never lets one end.
        const atRest = async () => {
          for (let i = 0; i < 2000; i += 1) {
            const last = (await latest().fetchHistory()).events?.at(-1);
            if (
              last?.timerStartedEventAttributes ??
              last?.timerCanceledEventAttributes ??
              last?.workflowTaskCompletedEventAttributes
            ) {
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error('the saga never came to rest');
        };
        while (runs.size < 40) {
          await atRest();
          await latest().signal(retryDisputeRelease);
          runs.add((await latest().describe()).runId);
        }
        await atRest();
        // One attempt (30 s) answers a query the rollover dropped; the 60 s bound sits
        // below the ~80 s at which the server's keepalive GOAWAY would free an unbounded
        // one, so only the interceptor can make it.
        let timer: NodeJS.Timeout | undefined;
        const phases = await Promise.race([
          Promise.all(queries),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('a query was never answered')), 60_000);
          }),
        ]).finally(() => clearTimeout(timer));
        await latest().terminate('test finished');
        return { runs: runs.size, phases };
      });
      expect(outcome.runs).toBeGreaterThanOrEqual(40);
      expect(outcome.phases.length).toBeGreaterThanOrEqual(40);
      expect(new Set(outcome.phases)).toEqual(new Set(['OBLIGATION_RECONCILIATION']));
    });
  });
});
