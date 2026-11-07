import { mkdir } from 'node:fs/promises';
import {
  isGrpcCancelledError,
  isGrpcDeadlineError,
  type Connection,
  type WorkflowClientInterceptor,
} from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';

/** One query attempt's deadline: an answer slower than this only costs another attempt. */
export const QUERY_ATTEMPT_MS = 5_000;
/** Attempts before a query fails the test: 30 s, a quarter of a spec's timeout. */
export const QUERY_ATTEMPTS = 6;

/**
 * Every query through the environment's client has a deadline, and a query the run
 * under it closed on is asked again.
 *
 * The time-skipping test server does not answer a query that reaches a run in the
 * workflow task that continues it as new: the run runs no more tasks, so the query is
 * either cancelled (`CANCELLED`) or left waiting. With no deadline it waited until the
 * server dropped the connection for keepalive pings (~80 s, then longer, as gRPC
 * doubles the ping interval), past the test's timeout (#935, run 42391595495); still
 * waiting at teardown, its gRPC retry then fired into the next spec file of the same
 * in-band run ("Channel has been shut down"). Asked again, it reaches the new run
 * (`getHandle(id)` follows the chain); a query writes nothing, so asking twice changes
 * nothing. No spec aborts a query through this client, so a `CANCELLED` here is the
 * server's. Any other failure (an unregistered query, a missing workflow) is thrown as
 * it came, and a saga that answers no attempt fails the test, named, well before the
 * test's timeout.
 */
export function boundedQueries(connection: () => Connection): WorkflowClientInterceptor {
  return {
    async query(input, next) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await connection().withDeadline(Date.now() + QUERY_ATTEMPT_MS, () => next(input));
        } catch (error) {
          if (!isGrpcDeadlineError(error) && !isGrpcCancelledError(error)) throw error;
          if (attempt >= QUERY_ATTEMPTS) {
            throw new Error(
              `query ${input.queryType} on ${input.workflowExecution.workflowId} answered none of ${QUERY_ATTEMPTS} attempts of ${QUERY_ATTEMPT_MS} ms`,
              { cause: error },
            );
          }
        }
      }
    },
  };
}

export async function createTemporalTestEnvironment(): Promise<TestWorkflowEnvironment> {
  const downloadDir = process.env.TEMPORAL_TEST_SERVER_DIR;
  if (process.env.CI && !downloadDir) {
    throw new Error('Temporal specs in CI require TEMPORAL_TEST_SERVER_DIR');
  }
  // cached-download fetches a missing executable; ensure a cold cache has a directory.
  if (downloadDir) await mkdir(downloadDir, { recursive: true });
  const env: TestWorkflowEnvironment = await TestWorkflowEnvironment.createTimeSkipping({
    server: { executable: { type: 'cached-download', downloadDir, ttl: '30 days' } },
    client: {
      interceptors: {
        workflow: [
          // Read at the first query, once `env` is set.
          boundedQueries(() => env.connection),
        ],
      },
    },
  });
  return env;
}
