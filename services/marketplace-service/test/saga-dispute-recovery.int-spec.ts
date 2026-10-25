import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MockActivityEnvironment } from '@temporalio/testing';
import { runUnscoped, type InternalTokenService } from '@rasta/nest-common';
import { SAGA_DISPUTE_RECOVERY, type SagaDisputeRecoveryRow } from '@rasta/testing';
import { ulid } from 'ulid';
import { createActivities, type OrderActivities } from '../src/temporal/activities';
import { EconomicClient, idempotencyKeyFor } from '../src/economic/economic.client';
import type { MarketplaceEnv } from '../src/config/env';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  asActor,
  cleanup,
  key,
  newPrisma,
  publishOffer,
  tenants,
  wire,
  type Wiring,
} from './helpers';

/**
 * marketplace-service's half of `SAGA_DISPUTE_RECOVERY` (@rasta/testing): the
 * saga mirrors an operator's resolution to economic-service, the resolution
 * commits there and its answer is lost, and the retry arrives after
 * economic-service let the stored answer expire (D-053, D-060, Codex on #322).
 *
 * economic-service refuses the retry for the state the first attempt produced,
 * and the saga reads the transaction for its own effect. Since economic-service
 * keeps the objection in `disputeReason`, the resolution's words are in
 * `disputeResolution` — except on a transaction resolved before that field,
 * where they were written over the objection. Before this was fixed the saga
 * looked in `disputeReason` alone: it refused its own completed resolution,
 * and the workflow failed before settlement or refund with the escrow held.
 *
 * Everything on this side is real — the activities in
 * `MockActivityEnvironment`, the order, the step record, and `EconomicClient`
 * over HTTP. economic-service is a local HTTP server answering exactly what
 * the fixture says it answers; economic-service's own suite
 * (`saga-resolution-after-ttl.int-spec.ts`) holds it to the same fixture.
 */
describe('a dispute resolution retried after economic-service let its answer expire (Codex on #322)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();
  const { reason, resolution, refusedRetry, readAfter } = SAGA_DISPUTE_RECOVERY;
  const servers: Server[] = [];

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
  });

  const asBuyer = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-SDR-B' }, fn);
  const asSupplier = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.supplier, roles: ['SUPPLIER'], userId: 'USR-SDR-S' }, fn);

  /**
   * economic-service, as far as these steps reach it, once its stored answers
   * have expired: a resolution is judged against the state now. `after` is
   * what a resolution leaves on the transaction — a key set to `undefined` is
   * not sent at all, as from an economic-service older than the field.
   */
  async function economicService(after: Record<string, unknown>) {
    const requests: string[] = [];
    // What the client sent that the saga never sends. Collected, not thrown:
    // an assertion failing in here would take the whole run down.
    const problems: string[] = [];
    const obligation: Record<string, unknown> = {
      id: `TXN_${ulid()}`,
      organizationId: org.buyer,
      counterpartyOrganizationId: org.supplier,
      transactionType: 'MARKETPLACE_ORDER',
      status: 'HELD',
      grossAmountMinor: '500000',
      commissionAmountMinor: '0',
      netAmountMinor: '500000',
      currency: 'IRR',
      sourceReference: null,
      disputedAt: null,
      disputeReason: null,
      disputeResolution: null,
      settlement: null,
    };
    let loseNext = false;

    const view = () =>
      Object.fromEntries(Object.entries(obligation).filter(([, value]) => value !== undefined));
    const answer = (res: ServerResponse, status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        // The saga's service token, for the buyer and nobody else.
        if (req.headers['x-internal-token'] !== `token-for-${org.buyer}`) {
          problems.push(`${req.method} ${req.url}: not the buyer's service token`);
        }
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const route = `${req.method} ${req.url?.replace(String(obligation.id), '{id}')}`;
        requests.push(`${route} ${req.headers['idempotency-key'] ?? ''}`.trim());

        switch (route) {
          case 'POST /v1/transactions':
            obligation.sourceReference = body.sourceReference;
            return answer(res, 201, view());
          case 'POST /v1/transactions/{id}/dispute':
            obligation.status = 'DISPUTED';
            obligation.disputedAt = new Date().toISOString();
            obligation.disputeReason = body.reason;
            return answer(res, 200, view());
          case 'POST /v1/transactions/{id}/resolve-dispute':
            if (obligation.status !== 'DISPUTED') {
              return answer(res, refusedRetry.status, {
                code: refusedRetry.code,
                message: `Transaction cannot move from ${String(obligation.status)} to PENDING_SETTLEMENT`,
              });
            }
            if (JSON.stringify(body) !== JSON.stringify({ resolution })) {
              problems.push(`resolve-dispute sent ${raw}`);
            }
            Object.assign(obligation, after);
            if (loseNext) {
              // Committed; the answer never arrives.
              loseNext = false;
              return req.socket.destroy();
            }
            return answer(res, 200, view());
          case 'GET /v1/transactions/{id}':
            return answer(res, 200, view());
          default:
            return answer(res, 404, { code: 'NOT_FOUND', message: 'Not found' });
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const env = {
      ECONOMIC_SERVICE_URL: `http://127.0.0.1:${port}`,
      ECONOMIC_REQUEST_TIMEOUT_MS: 5_000,
    } as MarketplaceEnv;
    const tokens = {
      issue: async (_caller: string, _target: string, _purpose: string, organizationId: string) =>
        `token-for-${organizationId}`,
    } as unknown as InternalTokenService;

    return {
      economic: new EconomicClient(env, tokens),
      requests,
      problems,
      obligation,
      loseNextAnswer: () => {
        loseNext = true;
      },
    };
  }

  /** One saga run; `attempt` is the only thing a Temporal retry changes. */
  function sagaRun(orderId: string, economic: EconomicClient) {
    const activities = createActivities({ orders: wiring.orders, economic });
    const runId = `RUN-${ulid()}`;
    const scheduled = new Map<number, number>();
    return <R>(
      activityId: number,
      attempt: number,
      fn: (acts: OrderActivities) => Promise<R>,
    ): Promise<R> => {
      if (!scheduled.has(activityId)) scheduled.set(activityId, Date.now());
      const env = new MockActivityEnvironment({
        workflowExecution: { workflowId: `order-${orderId}`, runId },
        activityId: String(activityId),
        attempt,
        scheduledTimestampMs: scheduled.get(activityId)!,
      });
      return env.run(() => fn(activities));
    };
  }

  async function recordsOf(orderId: string) {
    return runUnscoped('the suite reads the records the saga wrote', () =>
      prisma.client.sagaStep.findMany({ where: { orderId }, select: { activity: true } }),
    );
  }

  /**
   * An order held, delivered and disputed by its buyer, with the dispute
   * mirrored to economic-service; then the operator's resolution, whose first
   * attempt commits there and loses its answer.
   */
  async function resolutionLost(after: Record<string, unknown>) {
    const service = await economicService(after);
    const { offerId } = await publishOffer(wiring, org.supplier, { unitPriceMinor: '500000' });
    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('SDR')),
    );
    const orderId = order.id;
    const run = sagaRun(orderId, service.economic);

    const { transactionId } = await run(2, 1, (a) => a.createObligation(orderId));
    await run(3, 1, (a) => a.markFundsHeld(orderId, transactionId));
    await asSupplier(async () => {
      await wiring.orders.confirm(orderId);
      await wiring.orders.fulfill(orderId, {});
    });
    await asBuyer(() => wiring.orders.confirmReceipt(orderId, {}));
    await asBuyer(() => wiring.orders.raiseDispute(orderId, { reason }));
    const { dispute } = await run(4, 1, (a) => a.readOrder(orderId));
    const disputeId = dispute!.id;
    await run(5, 1, (a) => a.disputeObligation(orderId, transactionId, disputeId, reason));

    service.loseNextAnswer();
    await expect(
      run(6, 1, (a) => a.resolveObligationDispute(orderId, transactionId, disputeId, resolution)),
    ).rejects.toMatchObject({ type: 'UPSTREAM_UNAVAILABLE', nonRetryable: false });
    expect(service.obligation.status).toBe('PENDING_SETTLEMENT');
    expect(await recordsOf(orderId)).not.toContainEqual({ activity: 'resolveObligationDispute' });

    const resolveKey = `POST /v1/transactions/{id}/resolve-dispute ${idempotencyKeyFor.resolveDispute(orderId, disputeId)}`;
    const retry = (attempt: number) =>
      run(6, attempt, (a) =>
        a.resolveObligationDispute(orderId, transactionId, disputeId, resolution),
      );
    return { orderId, service, resolveKey, retry };
  }

  const ROWS: [string, Record<string, unknown>][] = [
    ...(Object.keys(readAfter) as SagaDisputeRecoveryRow[]).map(
      (row): [string, Record<string, unknown>] => [row, { ...readAfter[row] }],
    ),
    [
      'from an economic-service older than disputeResolution',
      { ...readAfter.resolvedBeforeTheField, disputeResolution: undefined },
    ],
  ];

  it.each(ROWS)(
    'transaction %s: the refused retry is answered from the transaction, recorded, and not asked again',
    async (_, after) => {
      const { orderId, service, resolveKey, retry } = await resolutionLost(after);
      const before = service.requests.length;

      // Refused PENDING_SETTLEMENT -> PENDING_SETTLEMENT, then read back: this
      // resolution's effect. It used to stay a refusal until the attempts ran
      // out, and the workflow failed with the funds held.
      await expect(retry(2)).resolves.toBeUndefined();
      expect(await recordsOf(orderId)).toContainEqual({ activity: 'resolveObligationDispute' });

      // Recorded: a third attempt asks nobody.
      await expect(retry(3)).resolves.toBeUndefined();
      expect(service.requests.slice(before)).toEqual([resolveKey, 'GET /v1/transactions/{id}']);
      expect(service.problems).toEqual([]);
    },
  );

  it.each([
    [
      'another resolution’s words beside an objection worded like this one',
      { status: 'PENDING_SETTLEMENT', disputeReason: resolution, disputeResolution: 'Refunded.' },
    ],
    [
      'no resolution kept apart and the objection still in place',
      { status: 'PENDING_SETTLEMENT', disputeReason: reason, disputeResolution: null },
    ],
  ])('a transaction carrying %s proves nothing: the refusal stands', async (_, after) => {
    const { orderId, service, retry } = await resolutionLost(after);

    await expect(retry(2)).rejects.toMatchObject({ type: 'INVALID_STATE_TRANSITION' });
    expect(await recordsOf(orderId)).not.toContainEqual({ activity: 'resolveObligationDispute' });
    expect(service.problems).toEqual([]);
  });
});
