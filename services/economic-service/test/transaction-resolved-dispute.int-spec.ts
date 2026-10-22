import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { TransactionRepository } from '../src/transaction/transaction.repository';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

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
});
