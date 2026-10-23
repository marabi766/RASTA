import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaClient } from '../src/generated/prisma';
import {
  RESOLVED_DISPUTE_BACKFILL_DEFAULTS,
  backfillResolvedDisputes,
  type ResolvedDisputeBackfillEvent,
} from '../src/transaction/resolved-dispute-backfill';
import { TransactionRepository } from '../src/transaction/transaction.repository';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id, ownerDatabaseUrl } from './helpers';

/**
 * A resolution is attributed to the dispute it decided by identity, never by
 * time (Codex on #322 round 4, finding 1; docs/23 D-060).
 *
 * A row keeps one dispute and one resolution. Resolved (A), disputed again
 * (B) and refunded from DISPUTED, it holds B's reason beside A's decision,
 * and readers told them apart by comparing `disputeResolvedAt` with
 * `disputedAt`. The re-dispute read its clock before waiting for the row
 * lock, the resolution read its clock later but locked first: B was dated
 * before A's decision, and A's decision read as B's. Now:
 *
 * - `resolvedDisputeId` names the dispute the resolution decided — the
 *   database's record, set on the move out of DISPUTED and kept;
 * - the instants are the database clock's, read once the row lock is held,
 *   so the lock's order is the instants' order.
 *
 * On a transaction any party may dispute directly (`LOGISTICS`): disputed by
 * its payer, resolved and refunded by the platform — the review's sequence.
 * The interleaving is forced, not timed: B is held at the row lock by a gate
 * on the repository's own lock read until A has committed.
 */
describe('a dispute resolution is attributed by identity, not by time', () => {
  let harness: ApiHarness;
  let http: Server;
  let repository: TransactionRepository;
  let owner: PrismaClient;

  const payer = apiTenant('RSDSP-PAYER');
  const payee = apiTenant('RSDSP-PAYEE');
  const platform = apiTenant('RSDSP-PLATFORM');

  const asPayer = () => `Bearer ${admin(payer)}`;
  const asPayee = () => `Bearer ${admin(payee)}`;
  const asPlatform = () => `Bearer ${admin(platform, ['SYSTEM_ADMIN'])}`;

  const REASON_A = 'Two pallets short on arrival.';
  const DECISION_A = 'Counted again at the depot: complete.';
  const REASON_B = 'The invoice names another supplier.';

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    repository = harness.app.get(TransactionRepository);
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });

    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asPayer());
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('rsdsp-fund'))
      .send({ amountMinor: '50000000' })
      .expect(201);
    await request(http).get('/v1/wallets/me').set('authorization', asPayee()).expect(200);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await owner.$disconnect();
    await cleanup(harness.prisma, [payer, payee, platform]);
    await harness.close();
  });

  async function heldObligation(): Promise<string> {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', id('rsdsp-held'))
      .send({
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '5000',
        currency: 'IRR',
        holdFunds: true,
      })
      .expect(201);
    return created.body.id as string;
  }

  const dispute = (transactionId: string, reason: string) =>
    request(http)
      .post(`/v1/transactions/${transactionId}/dispute`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('rsdsp-dispute'))
      .send({ reason });

  const resolve = (transactionId: string, resolution: string) =>
    request(http)
      .post(`/v1/transactions/${transactionId}/resolve-dispute`)
      .set('authorization', asPlatform())
      .set('idempotency-key', id('rsdsp-resolve'))
      .send({ resolution });

  const refund = (transactionId: string) =>
    request(http)
      .post(`/v1/transactions/${transactionId}/refund`)
      .set('authorization', asPlatform())
      .set('idempotency-key', id('rsdsp-refund'))
      .send({ reason: 'Refunded by the platform after the second dispute.' });

  /** The detail view, as the payee's portal reads it. */
  const read = async (transactionId: string) =>
    (
      await request(http)
        .get(`/v1/transactions/${transactionId}`)
        .set('authorization', asPayee())
        .expect(200)
    ).body as Record<string, string | null>;

  /** Disputed by the payer (A); returns A's identity. */
  async function disputedOnce(transactionId: string): Promise<string> {
    expect((await dispute(transactionId, REASON_A)).status).toBe(200);
    const a = (await read(transactionId)).disputeId;
    expect(a).toMatch(/^TXD_/);
    return a!;
  }

  it('the review’s interleaving: B waits at the lock, A is decided first — A’s decision stays A’s', async () => {
    const transactionId = await heldObligation();
    const a = await disputedOnce(transactionId);

    // B reaches the row lock first and is held there; A's resolution takes
    // the lock and commits; then B locks. Before this change B's instant was
    // read before the wait, so it was dated before A's decision.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = (): void => undefined;
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const lockForUpdate = repository.lockForUpdate.bind(repository);
    jest.spyOn(repository, 'lockForUpdate').mockImplementationOnce(async (tx, lockedId) => {
      arrived();
      await gate;
      return lockForUpdate(tx, lockedId);
    });

    const second = dispute(transactionId, REASON_B).then((response) => response);
    await waiting;
    let decided: request.Response;
    try {
      decided = await resolve(transactionId, DECISION_A);
    } finally {
      // Whatever A's outcome, B is let go: a held request would outlive the case.
      release();
    }
    expect((await second).status).toBe(200);
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({
      status: 'PENDING_SETTLEMENT',
      disputeId: a,
      resolvedDisputeId: a,
    });

    const redisputed = await read(transactionId);
    const b = redisputed.disputeId;
    expect(b).toMatch(/^TXD_/);
    expect(b).not.toBe(a);
    expect(redisputed).toMatchObject({
      status: 'DISPUTED',
      disputeReason: REASON_B,
      disputeResolution: DECISION_A,
      resolvedDisputeId: a,
    });
    // Dated in the order the lock let them happen.
    expect(Date.parse(redisputed.disputedAt!)).toBeGreaterThan(
      Date.parse(redisputed.disputeResolvedAt!),
    );

    expect((await refund(transactionId)).status).toBe(200);
    const refunded = await read(transactionId);
    expect(refunded).toMatchObject({
      status: 'REFUNDED',
      disputeId: b,
      disputeReason: REASON_B,
      disputeResolution: DECISION_A,
      // A's decision, still named as A's: B, refunded, was never resolved.
      resolvedDisputeId: a,
    });
  });

  it('inverted instants — a re-dispute dated by a clock behind — are attributed by identity all the same', async () => {
    // A pod of the release before this one still reads its clock before the
    // lock wait; so may a host whose clock runs behind. Its re-dispute is
    // written here as that pod writes it, dated an hour before A's decision.
    const transactionId = await heldObligation();
    const a = await disputedOnce(transactionId);
    expect((await resolve(transactionId, DECISION_A)).status).toBe(200);
    const resolvedAt = (await read(transactionId)).disputeResolvedAt!;

    await runUnscoped(
      'the suite re-disputes as a pod of the previous release would, with its own clock',
      () =>
        harness.prisma.client.$executeRaw`UPDATE "transaction"
           SET status = 'DISPUTED',
               disputed_at = ${new Date(Date.parse(resolvedAt) - 3_600_000)},
               disputed_by = 'USR-PREVIOUS-RELEASE',
               dispute_reason = ${REASON_B}
         WHERE id = ${transactionId}`,
    );
    expect((await refund(transactionId)).status).toBe(200);

    const refunded = await read(transactionId);
    // By time, A's decision would read as B's — the screen's old rule.
    expect(Date.parse(refunded.disputeResolvedAt!)).toBeGreaterThanOrEqual(
      Date.parse(refunded.disputedAt!),
    );
    // By identity it is not.
    expect(refunded.disputeId).toMatch(/^TXD_/);
    expect(refunded.disputeId).not.toBe(a);
    expect(refunded.resolvedDisputeId).toBe(a);
  });

  it('a resolution of the latest dispute names it, through settlement queue and refund', async () => {
    const transactionId = await heldObligation();
    await disputedOnce(transactionId);
    expect((await resolve(transactionId, DECISION_A)).status).toBe(200);
    expect((await dispute(transactionId, REASON_B)).status).toBe(200);
    const b = (await read(transactionId)).disputeId;

    const decided = await resolve(transactionId, 'The supplier corrected the invoice.');
    expect(decided.body).toMatchObject({ disputeId: b, resolvedDisputeId: b });

    expect((await refund(transactionId)).status).toBe(200);
    expect(await read(transactionId)).toMatchObject({
      status: 'REFUNDED',
      disputeId: b,
      resolvedDisputeId: b,
      disputeReason: REASON_B,
      disputeResolution: 'The supplier corrected the invoice.',
    });
  });

  it('never disputed, or disputed and not yet resolved: no resolved dispute', async () => {
    const transactionId = await heldObligation();
    expect(await read(transactionId)).toMatchObject({ disputeId: null, resolvedDisputeId: null });
    await disputedOnce(transactionId);
    expect((await read(transactionId)).resolvedDisputeId).toBeNull();
  });

  it('the attribution is the database’s: a write can neither set nor change it', async () => {
    const transactionId = await heldObligation();
    const resolvedId = async () =>
      (
        await runUnscoped(
          'the suite reads the attribution',
          () =>
            harness.prisma.client.$queryRaw<{ resolved_dispute_id: string | null }[]>`
            SELECT resolved_dispute_id FROM "transaction" WHERE id = ${transactionId}`,
        )
      )[0]!.resolved_dispute_id;
    const forge = (sql: 'alone' | 'withStatus') =>
      runUnscoped('the suite forges an attribution', () =>
        sql === 'alone'
          ? harness.prisma.client.$executeRaw`UPDATE "transaction"
               SET resolved_dispute_id = 'TXD_FORGED' WHERE id = ${transactionId}`
          : harness.prisma.client.$executeRaw`UPDATE "transaction"
               SET status = 'PENDING_SETTLEMENT', dispute_resolved_at = now(),
                   resolved_dispute_id = 'TXD_FORGED'
             WHERE id = ${transactionId}`,
      );

    await forge('alone');
    expect(await resolvedId()).toBeNull();

    const a = await disputedOnce(transactionId);
    await forge('alone');
    expect(await resolvedId()).toBeNull();

    // Out of DISPUTED by a writer that names a forged one — a pod of the
    // previous release, or an operator's statement: the held dispute instead.
    await forge('withStatus');
    expect(await resolvedId()).toBe(a);

    await forge('alone');
    expect(await resolvedId()).toBe(a);
  });

  // ---- Rows resolved before the column (Codex on #352, finding 1) -----------

  /**
   * The row as the migration finds it: resolved, or resolved and moved on, by
   * the previous release, with no identity. Written by the owner with the
   * trigger lifted inside its own transaction, which no other session sees.
   */
  const asBeforeTheColumn = (transactionId: string) =>
    owner.$transaction([
      // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; this transaction
      // bounds it, and re-enables the trigger before it commits.
      owner.$executeRawUnsafe(
        'ALTER TABLE "transaction" DISABLE TRIGGER "trg_transaction_resolved_dispute"',
      ),
      owner.$executeRaw`UPDATE "transaction" SET resolved_dispute_id = NULL WHERE id = ${transactionId}`,
      owner.$executeRawUnsafe(
        'ALTER TABLE "transaction" ENABLE TRIGGER "trg_transaction_resolved_dispute"',
      ),
    ]);

  /** Resolved (A) before the column; returns A. */
  async function resolvedBeforeTheColumn(transactionId: string): Promise<string> {
    const a = await disputedOnce(transactionId);
    expect((await resolve(transactionId, DECISION_A)).status).toBe(200);
    await asBeforeTheColumn(transactionId);
    expect(await read(transactionId)).toMatchObject({
      status: 'PENDING_SETTLEMENT',
      disputeId: a,
      resolvedDisputeId: null,
    });
    return a;
  }

  const backfill = (
    options: Partial<typeof RESOLVED_DISPUTE_BACKFILL_DEFAULTS>,
    events: ResolvedDisputeBackfillEvent[] = [],
  ) =>
    backfillResolvedDisputes(
      harness.prisma.client,
      { ...RESOLVED_DISPUTE_BACKFILL_DEFAULTS, ...options },
      (event) => events.push(event),
    );

  it('a resolution recorded before the column is attributed by the row’s next move', async () => {
    // Disputed again by the API: the trigger names A, from the row under the
    // lock, before the new dispute replaces `dispute_id`.
    const redisputed = await heldObligation();
    const a = await resolvedBeforeTheColumn(redisputed);
    expect((await dispute(redisputed, REASON_B)).status).toBe(200);
    const b = (await read(redisputed)).disputeId;
    expect(b).not.toBe(a);
    expect(await read(redisputed)).toMatchObject({ disputeId: b, resolvedDisputeId: a });
    expect((await refund(redisputed)).status).toBe(200);
    expect(await read(redisputed)).toMatchObject({
      status: 'REFUNDED',
      disputeId: b,
      resolvedDisputeId: a,
    });

    // Refunded straight out of the queue: A's.
    const refunded = await heldObligation();
    const a2 = await resolvedBeforeTheColumn(refunded);
    expect((await refund(refunded)).status).toBe(200);
    expect(await read(refunded)).toMatchObject({ status: 'REFUNDED', resolvedDisputeId: a2 });
  });

  it('the backfill attributes the certain rows, in batches, and nothing else', async () => {
    const queued = await heldObligation();
    const a = await resolvedBeforeTheColumn(queued);

    // Resolved (A), disputed again (B), refunded from DISPUTED — then the
    // identity lost, as on a row of the previous release: which dispute the
    // resolution decided is not on the row, so it stays unattributed.
    const refunded = await heldObligation();
    await disputedOnce(refunded);
    expect((await resolve(refunded, DECISION_A)).status).toBe(200);
    expect((await dispute(refunded, REASON_B)).status).toBe(200);
    expect((await refund(refunded)).status).toBe(200);
    await asBeforeTheColumn(refunded);
    // Resolved, disputed again and still open: as unsure.
    const open = await heldObligation();
    await disputedOnce(open);
    expect((await resolve(open, DECISION_A)).status).toBe(200);
    expect((await dispute(open, REASON_B)).status).toBe(200);
    await asBeforeTheColumn(open);
    const never = await heldObligation();

    // A plan counts and writes nothing.
    const planned = await backfill({});
    expect(planned).toMatchObject({ status: 'planned', batches: 0, attributed: 0 });
    expect(planned.unattributed).toBeGreaterThanOrEqual(1);
    expect((await read(queued)).resolvedDisputeId).toBeNull();

    const events: ResolvedDisputeBackfillEvent[] = [];
    const applied = await backfill({ apply: true, batchSize: 7 }, events);
    expect(applied).toMatchObject({ status: 'done', unattributed: 0 });
    expect(applied.attributed).toBeGreaterThanOrEqual(1);
    const batches = events.filter((event) => event.event === 'batch');
    expect(batches.length).toBe(applied.batches);
    expect(batches.every((event) => event.scanned <= 7)).toBe(true);

    expect(await read(queued)).toMatchObject({ disputeId: a, resolvedDisputeId: a });
    for (const unsure of [refunded, open, never]) {
      expect((await read(unsure)).resolvedDisputeId).toBeNull();
    }
    // Nor does any write attribute them: the trigger derives only the certain.
    await runUnscoped(
      'the suite writes an attribution onto the unsure rows',
      () =>
        harness.prisma.client.$executeRaw`UPDATE "transaction"
         SET resolved_dispute_id = dispute_id WHERE id IN (${refunded}, ${open}, ${never})`,
    );
    for (const unsure of [refunded, open, never]) {
      expect((await read(unsure)).resolvedDisputeId).toBeNull();
    }

    // Again: nothing left to do.
    expect(await backfill({ apply: true })).toMatchObject({ status: 'done', attributed: 0 });
  });

  /** Disputes the row again (B) in a transaction held open until released. */
  function redisputedAndHeld(transactionId: string) {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written = (): void => undefined;
    const moved = new Promise<void>((resolve) => {
      written = resolve;
    });
    const done = harness.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE "transaction"
           SET status = 'DISPUTED', disputed_at = clock_timestamp(),
               disputed_by = 'USR-CONCURRENT', dispute_reason = ${REASON_B}
         WHERE id = ${transactionId}`;
        written();
        await gate;
      },
      { timeout: 30_000 },
    );
    return { moved, release, done };
  }

  /** Until some session waits on a row lock — the batch, behind the held move. */
  async function untilWaitingOnARow(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await owner.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype = 'transactionid'`;
      if ((row?.n ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the batch never waited on the held row');
  }

  it('a move a batch may not wait for stops the run, writing nothing, resumable where it stopped', async () => {
    const transactionId = await heldObligation();
    const a = await resolvedBeforeTheColumn(transactionId);
    // Just before the row, so the batch reads it first.
    const after = transactionId.slice(0, -1);

    const held = redisputedAndHeld(transactionId);
    await held.moved;
    const events: ResolvedDisputeBackfillEvent[] = [];
    let summary: Awaited<ReturnType<typeof backfill>>;
    try {
      summary = await backfill(
        { apply: true, after, batchSize: 5, maxBatches: 1, lockTimeoutMs: 200 },
        events,
      );
    } finally {
      held.release();
    }
    await held.done;

    expect(summary).toMatchObject({ status: 'failed', batches: 0, attributed: 0, lastId: after });
    expect(events).toContainEqual({ event: 'failed', batch: 1, after, code: '55P03' });
    // Attributed by the move itself, from the row it locked.
    const moved = await read(transactionId);
    expect(moved.disputeId).not.toBe(a);
    expect(moved).toMatchObject({ status: 'DISPUTED', resolvedDisputeId: a });
  });

  it('a move that commits while a batch waits on its row is attributed by the move, never by the batch', async () => {
    const transactionId = await heldObligation();
    const a = await resolvedBeforeTheColumn(transactionId);
    const after = transactionId.slice(0, -1);

    // The batch read the row as PENDING_SETTLEMENT with A; it waits; the move
    // commits B. A batch that wrote `dispute_id` as it found it after the wait
    // would name B — the dispute nobody resolved.
    const held = redisputedAndHeld(transactionId);
    await held.moved;
    let running: ReturnType<typeof backfill> | undefined;
    try {
      running = backfill({
        apply: true,
        after,
        batchSize: 5,
        maxBatches: 1,
        lockTimeoutMs: 10_000,
      });
      await untilWaitingOnARow();
    } finally {
      held.release();
    }
    await held.done;
    expect((await running).status).not.toBe('failed');

    const moved = await read(transactionId);
    expect(moved.disputeId).toMatch(/^TXD_/);
    expect(moved.disputeId).not.toBe(a);
    expect(moved).toMatchObject({
      status: 'DISPUTED',
      disputeReason: REASON_B,
      resolvedDisputeId: a,
    });
  });
});
