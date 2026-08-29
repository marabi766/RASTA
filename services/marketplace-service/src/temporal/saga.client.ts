import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { ENV } from '../tokens';
import type { MarketplaceEnv } from '../config/env';

/**
 * Starts and signals `OrderSagaWorkflow`.
 *
 * ## Why the database is written first and the signal sent second
 *
 * Every command applies its state change and commits it, and only then tells
 * the workflow. If the signal fails, the order is still correct and the
 * workflow re-reads on its next wake-up. The other order — signal first —
 * would leave a workflow that believes something the database does not, and
 * the workflow is the thing driving money.
 *
 * A failed signal is therefore logged and swallowed rather than raised: the
 * user's command succeeded, and telling them it failed would invite a retry
 * that changes nothing.
 *
 * ## Why `workflowId` is the order id
 *
 * Temporal refuses to start a second workflow with an id that is already
 * running. That makes "one saga per order" structural rather than a rule the
 * code has to keep — even if two requests race to start one.
 */
@Injectable()
export class OrderSagaClient implements OnModuleDestroy {
  private readonly logger = new Logger(OrderSagaClient.name);
  private client?: Client;
  private connection?: Connection;
  private connecting?: Promise<Client>;

  constructor(@Inject(ENV) private readonly env: MarketplaceEnv) {}

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const connection = await Connection.connect({ address: this.env.TEMPORAL_ADDRESS });
      this.connection = connection;
      const client = new Client({ connection, namespace: this.env.TEMPORAL_NAMESPACE });
      this.client = client;
      this.logger.log(`Temporal client connected to ${this.env.TEMPORAL_ADDRESS}`);
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

  /**
   * Starts the saga for a freshly placed order.
   *
   * Failure is logged rather than raised: the order exists and is `PENDING`,
   * which is a visible state an operator can act on. Failing the HTTP request
   * would tell the buyer their order did not happen when it did.
   */
  async start(orderId: string): Promise<void> {
    if (!this.env.MARKETPLACE_TEMPORAL_ENABLED) {
      this.logger.warn(`Temporal is disabled; order ${orderId} stays PENDING until a worker runs`);
      return;
    }

    try {
      const client = await this.getClient();
      await client.workflow.start('orderSaga', {
        taskQueue: this.env.MARKETPLACE_TEMPORAL_TASK_QUEUE,
        workflowId: OrderSagaClient.workflowIdFor(orderId),
        args: [
          {
            orderId,
            fulfillmentWindowDays: this.env.MARKETPLACE_FULFILLMENT_WINDOW_DAYS,
            receiptWindowDays: this.env.MARKETPLACE_RECEIPT_WINDOW_DAYS,
            reminderIntervalDays: this.env.MARKETPLACE_REMINDER_INTERVAL_DAYS,
          },
        ],
      });
    } catch (error) {
      this.logger.error({ orderId, err: error }, 'Could not start the order saga');
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
      this.logger.error({ orderId, signalName, err: error }, 'Could not signal the order saga');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }
}
