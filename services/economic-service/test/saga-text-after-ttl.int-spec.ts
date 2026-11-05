import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { SAGA_DISPUTE_RECOVERY } from '@rasta/testing';
import { admin, apiTenant, internalToken, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * A dispute, and its resolution, that the order saga sent with CRLF or CR line
 * endings, committed here, whose answers were lost; retried after this service
 * let the stored answers expire (`ECONOMIC_IDEMPOTENCY_TTL_HOURS`) by
 * marketplace-service **before #747** (Codex PR-747 r3, F4).
 *
 * The retry is refused for the state the first attempt produced, and that
 * release's saga reads the transaction for its own effect, comparing the text
 * it sent **exactly**. Kept with LF line endings (#747 before r3 F4), its own
 * committed dispute or resolution was not found: INVALID_STATE_TRANSITION three
 * attempts running, and the saga failed with the funds held. Kept as sent —
 * what every release stored before canonicalization — it is found.
 *
 * `previousMarketplace` is that release's recovery, line for line: origin/main
 * d6347b67, services/marketplace-service/src/temporal/activities.ts, the
 * `answer` of `disputeObligation` (:605–:608) and of `resolveObligationDispute`
 * without an economic dispute identity (:657–:668, `resolutionOf` :740). The
 * services may not import each other (AGENTS.md A-02). Calls are made as its
 * `EconomicClient` makes them: a marketplace-service token signed for the
 * buyer, and the saga's keys.
 */
describe('saga text sent with CRLF, recovered after its stored answer expired by marketplace before #747', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('TTTL-PAYER');
  const payee = apiTenant('TTTL-PAYEE');
  const asSaga = () => internalToken('marketplace-service', { organizationId: payer });
  const { refusedRetry } = SAGA_DISPUTE_RECOVERY;

  type Read = Record<string, unknown> & {
    status: string;
    disputedAt: string | null;
    disputeId?: string | null;
    disputeReason: string | null;
    disputeResolution?: string | null;
  };

  /** marketplace-service before #747: the recovery's `answer`s, verbatim. */
  const previousMarketplace = {
    disputeObligation: (transaction: Read, reason: string) =>
      transaction.status === 'DISPUTED' && transaction.disputeReason === reason
        ? { result: transaction.disputeId ?? null }
        : null,
    resolveObligationDispute: (transaction: Read, resolution: string) => {
      const resolutionOf = (read: Read): string | null => {
        const keptApart = read.disputeResolution;
        if (keptApart !== null && keptApart !== undefined) return keptApart;
        return read.disputeReason;
      };
      const released =
        (transaction.status === 'HELD' ||
          transaction.status === 'PENDING_SETTLEMENT' ||
          transaction.status === 'SETTLED') &&
        transaction.disputedAt !== null;
      const ours = resolutionOf(transaction) === resolution;
      return released && ours ? { result: undefined } : null;
    },
  };

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(payer)}`)
      .expect(200);
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(payer)}`)
      .set('idempotency-key', id('tttl-fund'))
      .send({ amountMinor: '30000000' })
      .expect(201);
    await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(payee)}`)
      .expect(200);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee]);
    await harness.close();
  });

  /** Every answer the payer's commands left behind, aged past the TTL. */
  const expireAnswers = () =>
    runUnscoped('the suite ages the stored answers past the TTL', () =>
      harness.prisma.client.idempotencyKey.updateMany({
        where: { organizationId: payer },
        data: {
          createdAt: new Date(Date.now() - 25 * 3_600_000),
          expiresAt: new Date(Date.now() - 3_600_000),
        },
      }),
    );

  const readAsPayer = async (transactionId: string) =>
    (
      await request(http)
        .get(`/v1/transactions/${transactionId}`)
        .set('x-internal-token', await asSaga())
        .expect(200)
    ).body as Read;

  const stored = (transactionId: string) =>
    runUnscoped('the suite reads the stored text', () =>
      harness.prisma.client.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        select: { disputeReason: true, disputeResolution: true },
      }),
    );

  /** An order's obligation, held by the saga; its dispute and resolution commands. */
  async function obligation() {
    const order = `ORD_${ulid()}`;
    const dispute = `DSP_${ulid()}`;
    const token = await asSaga();
    const created = await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', token)
      .set('idempotency-key', `order:${order}:hold`)
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '500000',
        currency: 'IRR',
        sourceType: 'ORDER',
        sourceReference: order,
        holdFunds: true,
      })
      .expect(201);
    const transactionId = created.body.id as string;
    return {
      transactionId,
      dispute: (reason: string) =>
        request(http)
          .post(`/v1/transactions/${transactionId}/dispute`)
          .set('x-internal-token', token)
          .set('idempotency-key', `order:${order}:dispute:${dispute}`)
          .send({ reason }),
      // Without `disputeId`: as from a saga whose dispute step got none back.
      resolve: (resolution: string) =>
        request(http)
          .post(`/v1/transactions/${transactionId}/resolve-dispute`)
          .set('x-internal-token', token)
          .set('idempotency-key', `order:${order}:resolve-dispute:${dispute}`)
          .send({ resolution }),
    };
  }

  const SPELLINGS = [
    [
      'CRLF',
      'The pallets arrived\r\nwater-damaged on two sides.',
      'The carrier’s photographs\r\nshow the damage after delivery.',
    ],
    [
      'CR',
      'The pallets arrived\rwater-damaged on two sides.',
      'The carrier’s photographs\rshow the damage after delivery.',
    ],
  ] as const;

  it.each(SPELLINGS)(
    'disputeObligation, %s: the retry is refused for its own effect, and that release finds it',
    async (_, reason) => {
      const { transactionId, dispute } = await obligation();
      await dispute(reason).expect(200);
      expect(await stored(transactionId)).toMatchObject({ disputeReason: reason });

      await expireAnswers();
      const retried = await dispute(reason);
      expect({ status: retried.status, code: retried.body.code }).toEqual(refusedRetry);

      const read = await readAsPayer(transactionId);
      expect(read.disputeReason).toBe(reason);
      expect(previousMarketplace.disputeObligation(read, reason)).toEqual({
        result: read.disputeId ?? null,
      });
    },
  );

  it.each(SPELLINGS)(
    'resolveObligationDispute without an identity, %s: refused for its own effect, and that release finds it',
    async (_, reason, resolution) => {
      const { transactionId, dispute, resolve } = await obligation();
      await dispute(reason).expect(200);
      await resolve(resolution).expect(200);
      expect(await stored(transactionId)).toEqual({
        disputeReason: reason,
        disputeResolution: resolution,
      });

      await expireAnswers();
      const retried = await resolve(resolution);
      expect({ status: retried.status, code: retried.body.code }).toEqual(refusedRetry);

      const read = await readAsPayer(transactionId);
      expect(read.disputeResolution).toBe(resolution);
      expect(previousMarketplace.resolveObligationDispute(read, resolution)).toEqual({
        result: undefined,
      });
    },
  );
});
