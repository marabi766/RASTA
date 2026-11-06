import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
} from '@temporalio/client';
import { getOrganizationId, type OutboxStopOptions } from '@rasta/nest-common';
import { EconomicClient } from '../economic/economic.client';
import { SagaStartStore, type StartClaim } from './saga-start.store';
import {
  sagaStartBacklogAge,
  sagaStartBacklogCount,
  sagaStartDeliveries,
} from '../observability/metrics';
import { SERVICE_NAME } from '../config/env';
import { ENV } from '../tokens';
import type { MarketplaceEnv } from '../config/env';
import { foreignFailure } from './foreign-failure';
import { installTemporalRuntimeLogger } from './runtime-logger';

/** Durable, at-least-once saga start delivery (ADR-039/050).
 * Receipt is persisted only after acceptance or AlreadyStarted. Signals remain
 * best effort: the workflow always re-reads the committed order.
 */
const START_RPC_TIMEOUT_MS = 5000;
const START_CONNECT_TIMEOUT_MS = 1000;
const RETENTION_MARGIN_MS = 60_000;
const START_POLL_INTERVAL_MS = 10_000;

@Injectable()
export class OrderSagaClient implements OnModuleDestroy {
  private readonly logger = new Logger(OrderSagaClient.name);
  private client?: Client;
  private connection?: Connection;
  private connecting?: Promise<Client>;

  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly active = new Set<Promise<void>>();

  constructor(
    @Inject(ENV) private readonly env: MarketplaceEnv,
    private readonly store: SagaStartStore,
    @Inject(EconomicClient) private readonly economic: Pick<EconomicClient, 'provesHeldFunds'>,
  ) {}

  startPolling(): void {
    if (this.timer || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), START_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  /** Fast path after commit; a failure never changes the placement response. */
  async start(orderId: string): Promise<void> {
    if (!this.env.MARKETPLACE_TEMPORAL_ENABLED) return;
    await this.track(async () => {
      if (!(await this.economicReady())) return;
      const claims = await this.store.claim({ id: orderId, organizationId: getOrganizationId() });
      await Promise.all(claims.map((claim) => this.track(() => this.dispatch(claim))));
    });
  }

  /** One indexed keyset batch. Deferred failures move behind other due rows. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.track(async () => {
      const claims =
        this.env.MARKETPLACE_TEMPORAL_ENABLED && (await this.economicReady())
          ? await this.store.claim()
          : [];
      await Promise.all(claims.map((claim) => this.track(() => this.dispatch(claim))));
      if (this.stopped) return;
      const backlog = await this.store.backlog();
      sagaStartBacklogCount.set({ service: SERVICE_NAME }, backlog.count);
      sagaStartBacklogAge.set({ service: SERVICE_NAME }, backlog.age);
    }).finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private track(fn: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const task = fn()
      .catch((error: unknown) => {
        this.logger.error(
          { failure: foreignFailure(error) },
          'Saga start delivery will be retried',
        );
      })
      .finally(() => {
        this.active.delete(task);
      });
    this.active.add(task);
    return task;
  }

  /**
   * The prerequisite of any order's work: against an economic-service that cannot prove a
   * hold, a saga would place one and then wait on it (FU-138; ADR-040). Asked before the
   * claim, which starts the clock on a possibly started workflow: an order held back here
   * was provably not started, however long this lasts. The backlog metrics show the wait.
   */
  private async economicReady(): Promise<boolean> {
    const ready = await this.economic.provesHeldFunds();
    if (!ready) {
      sagaStartDeliveries.inc({ service: SERVICE_NAME, outcome: 'economic_not_ready' });
      this.logger.error('economic-service does not prove held funds; no order saga starts');
    }
    return ready && !this.stopped;
  }

  private async dispatch(claim: StartClaim): Promise<void> {
    if (this.stopped) return;
    const accepted = await this.deliver(claim.id, claim.age_ms);
    if (!this.stopped) await this.store.finish(claim, accepted);
  }

  async stop(_options?: OutboxStopOptions): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await Promise.all([...this.active]);
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      installTemporalRuntimeLogger(this.env);
      const connection = await Connection.connect({
        address: this.env.TEMPORAL_ADDRESS,
        connectTimeout: START_CONNECT_TIMEOUT_MS,
      });
      this.connection = connection;
      const client = new Client({ connection, namespace: this.env.TEMPORAL_NAMESPACE });
      this.client = client;
      // The setting, not its value: TEMPORAL_ADDRESS is a free string, and a
      // log line is no place to find out whether it carries credentials.
      this.logger.log('Temporal client connected (TEMPORAL_ADDRESS)');
      return client;
    })();

    try {
      return await this.connecting;
    } catch (error) {
      this.connecting = undefined;
      throw error;
    }
  }

  static workflowIdFor(orderId: string): string {
    return `order-${orderId}`;
  }

  /** Only explicit Temporal acceptance acknowledges a claim.
   * Once history could have expired, an absent execution is ambiguous. Ask
   * the namespace for its actual retention; never restart from absence then.
   */
  async deliver(orderId: string, possibleStartAgeMs = 0): Promise<boolean> {
    if (!this.env.MARKETPLACE_TEMPORAL_ENABLED || this.stopped) return false;

    try {
      const client = await this.getClient();
      return await client.connection.withAbortSignal(this.abort.signal, () =>
        client.connection.withDeadline(Date.now() + START_RPC_TIMEOUT_MS, async () => {
          {
            const namespace = await client.workflowService.describeNamespace({
              namespace: this.env.TEMPORAL_NAMESPACE,
            });
            const retention =
              Number(namespace.config?.workflowExecutionRetentionTtl?.seconds ?? 0) * 1000;
            // Age comes from the DB clock; the margin covers expiry during this bounded call.
            if (!Number.isFinite(retention) || retention <= RETENTION_MARGIN_MS) return false;
            if (possibleStartAgeMs >= retention - RETENTION_MARGIN_MS) {
              try {
                await client.workflow.getHandle(OrderSagaClient.workflowIdFor(orderId)).describe();
                return true; // Includes failed/closed workflows: never restart them.
              } catch (error) {
                if (!(error instanceof WorkflowNotFoundError)) throw error;
                sagaStartDeliveries.inc({ service: SERVICE_NAME, outcome: 'ambiguous' });
                return false;
              }
            }
          }
          await client.workflow.start('orderSaga', {
            taskQueue: this.env.MARKETPLACE_TEMPORAL_TASK_QUEUE,
            workflowId: OrderSagaClient.workflowIdFor(orderId),
            workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
            args: [
              {
                orderId,
                fulfillmentWindowDays: this.env.MARKETPLACE_FULFILLMENT_WINDOW_DAYS,
                receiptWindowDays: this.env.MARKETPLACE_RECEIPT_WINDOW_DAYS,
                reminderIntervalDays: this.env.MARKETPLACE_REMINDER_INTERVAL_DAYS,
                recheckIntervalHours: this.env.MARKETPLACE_SAGA_RECHECK_HOURS,
              },
            ],
          });
          sagaStartDeliveries.inc({ service: SERVICE_NAME, outcome: 'accepted' });
          return true;
        }),
      );
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        // A replayed placement: this order's saga is running or has already
        // run. That is the one outcome here that is not a problem.
        this.logger.debug({ orderId }, 'The order saga was already started');
        return true;
      }
      // By class and code only: the failure's own text may quote the address.
      this.logger.error(
        { orderId, failure: foreignFailure(error) },
        'Could not start the order saga',
      );
      sagaStartDeliveries.inc({ service: SERVICE_NAME, outcome: 'retry' });
      return false;
    }
  }

  /** Tells a running saga what a party just did. */
  async signal(orderId: string, signalName: string, ...args: unknown[]): Promise<void> {
    if (!this.env.MARKETPLACE_TEMPORAL_ENABLED) return;

    try {
      const client = await this.getClient();
      const handle = client.workflow.getHandle(OrderSagaClient.workflowIdFor(orderId));
      await handle.signal(signalName, ...args);
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        // The order's state change already committed. A saga that is not
        // running is a gap an operator can see and restart; it is not a reason
        // to fail the user's command after it succeeded.
        this.logger.warn({ orderId, signalName }, 'No running saga to signal');
        return;
      }
      this.logger.error(
        { orderId, signalName, failure: foreignFailure(error) },
        'Could not signal the order saga',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
    try {
      await this.connection?.close();
    } catch (error) {
      const failure = foreignFailure(error);
      throw new Error(
        `TEMPORAL_ADDRESS: Temporal close failed (${failure.type}, code ${failure.code ?? 'unknown'})`,
      );
    }
  }
}
