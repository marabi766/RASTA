import { randomBytes } from 'node:crypto';
import { eventEnvelopeSchema } from '@rasta/contracts';
import { actor, buyer, client, startApi, TestClock, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId, newProductId } from './helpers';
import { startSupplierStub, type SupplierStub } from './supplier-stub';

/**
 * The RFQ suites' harness (plan PR 6): the real application, a supplier-service stub over real HTTP,
 * a KEK minted for the run (never a literal: a secret scanner reads tests too), and a database clock
 * the suite pins — so an aggregation is READY exactly when the suite says, and a deadline is stood
 * on to the millisecond.
 */

export const HOUR = 3_600_000;
export const T0 = new Date('2031-03-01T08:00:00.000Z');
/** When `readyAggregation` leaves the clock: after the window it made READY ended (T0 + 10 h). */
export const AFTER_READY = new Date(T0.getTime() + 12 * HOUR);

/** A KEK for this run only, in the environment's shape. */
export function kekEnvironment(): Record<string, string> {
  return {
    PROCUREMENT_RFQ_KEKS: `run:${randomBytes(32).toString('base64')}`,
    PROCUREMENT_RFQ_KEK_CURRENT: 'run',
  };
}

export interface RfqHarness {
  api: ApiHarness;
  supplier: SupplierStub;
  clock: TestClock;
  kek: Record<string, string>;
  /** A fresh buyer organization, cleaned up with the suite. */
  org(): string;
  /**
   * A READY aggregation of `org` (5 units in two demands) on the timeline starting at `t0` (T0 by
   * default), the clock left 12 hours after it (AFTER_READY by default).
   */
  readyAggregation(
    organizationId?: string,
    t0?: Date,
  ): Promise<{
    organizationId: string;
    aggregation: { id: string; version: number; productId: string; status: string };
  }>;
  /** A valid issue body for `aggregation`, its invitees fresh eligible organizations. */
  issueBody(
    aggregation: { version: number },
    overrides?: Record<string, unknown>,
  ): Record<string, unknown> & { invitedSupplierOrganizationIds: string[] };
  /** The organization's administrator: the default RFQ issuer. */
  admin(organizationId: string, rastaUserId?: string): ReturnType<typeof client>;
  /** The event payloads of `eventName` the organization's outbox holds, oldest first. */
  events(organizationId: string, eventName: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export async function startRfqApi(env: Record<string, string> = {}): Promise<RfqHarness> {
  const supplier = await startSupplierStub({ slowMs: 1500 });
  const clock = new TestClock();
  const kek = kekEnvironment();
  const api = await startApi(
    {
      PROCUREMENT_AGGREGATION_WINDOW_HOURS: '10',
      PROCUREMENT_AGGREGATION_MIN_QUANTITY: '0',
      PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: 'EXTEND',
      SUPPLIER_SERVICE_URL: supplier.url,
      PROCUREMENT_SUPPLIER_REQUEST_TIMEOUT_MS: '1000',
      ...kek,
      ...env,
    },
    { clock },
  );
  const organizations: string[] = [];
  const org = () => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  return {
    api,
    supplier,
    clock,
    kek,
    org,
    readyAggregation: async (organizationId = org(), t0 = T0) => {
      const as = client(api, buyer(organizationId));
      const productId = newProductId();
      clock.set(t0);
      const first = (await as.submit({ productId, quantity: 2 })).body;
      clock.set(new Date(t0.getTime() + HOUR));
      await as.submit({ productId, quantity: 3 });
      // The demand that ends the window (READY) and opens the next one.
      clock.set(new Date(t0.getTime() + 10 * HOUR));
      await as.submit({ productId, quantity: 1 });
      clock.set(new Date(t0.getTime() + 12 * HOUR));
      const aggregation = (await as.aggregation(first.aggregationId as string)).body;
      if (aggregation.status !== 'READY') {
        throw new Error(`expected a READY aggregation, got ${String(aggregation.status)}`);
      }
      return { organizationId, aggregation };
    },
    issueBody: (aggregation, overrides = {}) =>
      ({
        expectedVersion: aggregation.version,
        procurementNature: 'INQUIRY',
        quotationClosingAt: new Date(AFTER_READY.getTime() + 48 * HOUR).toISOString(),
        criteria: [
          {
            code: 'PRICE',
            label: 'Unit price',
            weightBp: 7000,
            scoringMethod: 'MANUAL_SCORE',
            maxScore: 100,
          },
          {
            code: 'ISO',
            label: 'Certified',
            weightBp: 3000,
            scoringMethod: 'PASS_FAIL',
            maxScore: 1,
          },
        ],
        invitedSupplierOrganizationIds: [supplier.organization(), supplier.organization()],
        ...overrides,
      }) as Record<string, unknown> & { invitedSupplierOrganizationIds: string[] },
    admin: (organizationId, rastaUserId) =>
      client(
        api,
        actor(organizationId, ['ORGANIZATION_ADMIN'], rastaUserId ? { rastaUserId } : {}),
      ),
    events: async (organizationId, eventName) =>
      (
        await api.prisma.client.outboxMessage.findMany({
          where: { organizationId, eventName },
          // A pinned clock gives events one instant: their stream orders them exactly.
          orderBy: [{ createdAt: 'asc' }, { streamSeq: 'asc' }],
        })
      ).map((row) => eventEnvelopeSchema.parse(row.payload).payload as Record<string, unknown>),
    close: async () => {
      await cleanup(organizations);
      await api.close();
      await supplier.close();
    },
  };
}

/**
 * Resolves once a backend of this service's runtime role waits on a row lock (`pg_stat_activity`),
 * so a suite knows the request it started is parked behind the one holding the lock — a barrier,
 * never a sleep.
 */
export async function waitForLockWaiter(api: ApiHarness, query: RegExp): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const rows = await api.prisma.client.$queryRaw<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database()`;
    if (rows.some((row) => query.test(row.query))) return;
    if (Date.now() > deadline) throw new Error(`no backend waited on a lock for ${query}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A barrier a spied method waits at: `reached` when it gets there, `release` to let it go on. */
export function barrier(): {
  reached: Promise<void>;
  arrive: () => void;
  wait: Promise<void>;
  release: () => void;
} {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { reached, arrive, wait, release };
}
