import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaClient } from '../src/generated/prisma';
import { admin, apiTenant, internalToken, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id, ownerDatabaseUrl } from './helpers';

/**
 * Settlement needs settlement authority, whatever the status says (D-083;
 * review of #623 round 1, F1; migration 20261103121000).
 *
 * A release before D-083 resolved every dispute to PENDING_SETTLEMENT, so an
 * escrowed transaction disputed before anything authorised it came out
 * settlement-ready: an ACTIVE hold, no `settlement_authorised_at`. Those rows
 * are planted here exactly as that release wrote them — the dispute through
 * the API, the resolution as the old UPDATE, through the owner connection
 * with today's resolution trigger lifted for that one transaction — and then:
 *
 * - settlement refuses them, for the saga (ORDER) and for a person (any other
 *   escrowed type), with nothing written;
 * - the database refuses them too, past the service: the hold's release, and
 *   SETTLED after the hold is already released;
 * - the migration's reconciliation, run verbatim over them, returns the one
 *   resolved without authority to HELD and keeps the one authorised before
 *   the instant was recorded settleable; its down puts the first one back.
 */
jest.setTimeout(60_000);

const MIGRATION = join(
  __dirname,
  '../prisma/migrations/20261103121000_transaction_settlement_authority',
);

/** One statement of the migration (or its down), verbatim, from `start` to its `;`. */
function statement(file: 'migration.sql' | 'down.sql', start: string): string {
  const sql = readFileSync(join(MIGRATION, file), 'utf8');
  const from = sql.indexOf(start);
  const to = sql.indexOf(';', from);
  if (from < 0 || to < 0) throw new Error(`${file} has no statement starting ${start}`);
  return sql.slice(from, to);
}

const RECONCILE_INSERT = statement(
  'migration.sql',
  'INSERT INTO "settlement_authority_reconciliation"',
);
const RECONCILE_UPDATE = statement('migration.sql', 'UPDATE "transaction" t');
const DOWN_UPDATE = statement('down.sql', 'UPDATE "transaction" t');

/** A release as complete as settlement writes it (`ck_wallet_hold_resolution`), so only authority refuses it. */
const RELEASE_HOLD = `UPDATE wallet_hold
   SET status = 'RELEASED', resolved_at = now(), resolved_by = 'USR-STA-DEFECT',
       resolved_journal_id = placed_journal_id
 WHERE reference = $1 AND reference_type = 'TRANSACTION'`;

describe('settlement needs settlement authority, whatever the status says (D-083, #623 r1 F1)', () => {
  let harness: ApiHarness;
  let http: Server;
  let owner: PrismaClient;
  let suiteStart: Date;
  const planted: string[] = [];

  const payer = apiTenant('STA-PAYER');
  const payee = apiTenant('STA-PAYEE');
  const platform = apiTenant('STA-PLATFORM');

  const asPayer = () => `Bearer ${admin(payer)}`;
  const asSystemAdmin = () => `Bearer ${admin(platform, ['SYSTEM_ADMIN'])}`;
  const saga = () => internalToken('marketplace-service', { organizationId: payer });

  const AMOUNT = 7000n;

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    [{ now: suiteStart }] = await owner.$queryRawUnsafe<{ now: Date }[]>('SELECT now() AS now');

    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asPayer());
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('sta-fund'))
      .send({ amountMinor: '50000000' })
      .expect(201);
    await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(payee)}`)
      .expect(200);
  });

  afterAll(async () => {
    // The reconciliation table is frozen; this suite's own rows go with the
    // guard lifted in one owner transaction.
    await owner.$transaction(async (tx) => {
      // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this owner transaction.
      await tx.$executeRawUnsafe(
        'ALTER TABLE settlement_authority_reconciliation DISABLE TRIGGER trg_settlement_authority_reconciliation_frozen',
      );
      await tx.$executeRawUnsafe(
        // Its own rows, and anything its reconciliation runs found elsewhere.
        'DELETE FROM settlement_authority_reconciliation WHERE transaction_id = ANY($1::text[]) OR reconciled_at >= $2',
        planted,
        suiteStart,
      );
      await tx.$executeRawUnsafe(
        'ALTER TABLE settlement_authority_reconciliation ENABLE TRIGGER trg_settlement_authority_reconciliation_frozen',
      );
    });
    await owner.$disconnect();
    await cleanup(harness.prisma, [payer, payee, platform]);
    await harness.close();
  });

  const sagaCall = async (path: string, key: string, body: Record<string, unknown> = {}) =>
    request(http)
      .post(path)
      .set('x-internal-token', await saga())
      .set('idempotency-key', key)
      .send(body);

  /** Escrowed and HELD: an order's obligation (the saga's) or a person's LOGISTICS one. */
  async function held(
    kind: 'ORDER' | 'LOGISTICS',
  ): Promise<{ orderId: string; transactionId: string }> {
    const orderId = `ORD_${ulid()}`;
    const body = {
      transactionType: kind === 'ORDER' ? 'MARKETPLACE_ORDER' : 'LOGISTICS',
      counterpartyOrganizationId: payee,
      grossAmountMinor: AMOUNT.toString(),
      currency: 'IRR',
      holdFunds: true,
      ...(kind === 'ORDER' ? { sourceType: 'ORDER', sourceReference: orderId } : {}),
    };
    const created =
      kind === 'ORDER'
        ? await sagaCall('/v1/transactions', `order:${orderId}:hold`, body)
        : await request(http)
            .post('/v1/transactions')
            .set('authorization', asPayer())
            .set('idempotency-key', id('sta-hold'))
            .send(body);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('HELD');
    planted.push(created.body.id as string);
    return { orderId, transactionId: created.body.id as string };
  }

  /** Disputed through the API, then resolved as the release before D-083 wrote it. */
  async function legacyResolved(
    kind: 'ORDER' | 'LOGISTICS',
  ): Promise<{ orderId: string; transactionId: string }> {
    const row = await held(kind);
    const disputed =
      kind === 'ORDER'
        ? await sagaCall(
            `/v1/transactions/${row.transactionId}/dispute`,
            `order:${row.orderId}:dispute:1`,
            {
              reason: 'The buyer says the parts are the wrong model.',
            },
          )
        : await request(http)
            .post(`/v1/transactions/${row.transactionId}/dispute`)
            .set('authorization', asPayer())
            .set('idempotency-key', id('sta-dispute'))
            .send({ reason: 'The invoice names another supplier.' });
    expect(disputed.status).toBe(200);
    expect(disputed.body.status).toBe('DISPUTED');
    await owner.$transaction(async (tx) => {
      // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this owner transaction.
      await tx.$executeRawUnsafe(
        'ALTER TABLE "transaction" DISABLE TRIGGER trg_transaction_dispute_resolution',
      );
      await tx.$executeRawUnsafe(
        `UPDATE "transaction"
            SET status = 'PENDING_SETTLEMENT', dispute_resolved_at = now(),
                dispute_resolved_by = 'USR-STA-OLD-RELEASE', dispute_resolution = 'Dispute resolved: SETTLE'
          WHERE id = $1 AND status = 'DISPUTED'`,
        row.transactionId,
      );
      await tx.$executeRawUnsafe(
        'ALTER TABLE "transaction" ENABLE TRIGGER trg_transaction_dispute_resolution',
      );
    });
    return row;
  }

  /** Authorised before 20260926120000 recorded the instant: PENDING_SETTLEMENT, held, never disputed. */
  async function legacyAuthorised(): Promise<string> {
    const { transactionId } = await held('LOGISTICS');
    await owner.$executeRawUnsafe(
      `UPDATE "transaction" SET status = 'PENDING_SETTLEMENT' WHERE id = $1 AND status = 'HELD'`,
      transactionId,
    );
    return transactionId;
  }

  async function moneyOf(transactionId: string) {
    return runUnscoped('the suite reads the rows that record the money', async () => {
      const client = harness.prisma.client;
      const transaction = await client.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        select: { status: true, settlementAuthorisedAt: true, disputedAt: true },
      });
      const holds = await client.walletHold.findMany({
        where: { reference: transactionId, referenceType: 'TRANSACTION' },
        select: { status: true },
      });
      const journals = await client.journal.findMany({
        where: { transactionId },
        select: { journalType: true },
      });
      return {
        status: transaction.status,
        authorised: transaction.settlementAuthorisedAt !== null,
        holds: holds.map((hold) => hold.status),
        journals: journals.map((journal) => journal.journalType).sort(),
        settlements: await client.settlement.count({ where: { transactionId } }),
      };
    });
  }

  const legacyShape = {
    status: 'PENDING_SETTLEMENT',
    authorised: false,
    holds: ['ACTIVE'],
    journals: ['FUNDS_HELD'],
    settlements: 0,
  };

  const settleAsPayer = (transactionId: string) =>
    request(http)
      .post('/v1/settlements')
      .set('authorization', asPayer())
      .set('idempotency-key', id('sta-settle'))
      .send({ transactionId });

  it('the saga cannot settle an order the old release resolved before any authorisation', async () => {
    const { orderId, transactionId } = await legacyResolved('ORDER');
    expect(await moneyOf(transactionId)).toEqual(legacyShape);

    const refused = await sagaCall('/v1/settlements', `order:${orderId}:settle`, { transactionId });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(await moneyOf(transactionId)).toEqual(legacyShape);
  });

  it('nor can a person settle any other escrowed type left that way — payer or system administrator', async () => {
    const { transactionId } = await legacyResolved('LOGISTICS');
    for (const authorization of [asPayer(), asSystemAdmin()]) {
      const refused = await request(http)
        .post('/v1/settlements')
        .set('authorization', authorization)
        .set('idempotency-key', id('sta-settle'))
        .send({ transactionId });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('INVALID_STATE_TRANSITION');
    }
    expect(await moneyOf(transactionId)).toEqual(legacyShape);
  });

  it('the database refuses the same past the service: the release, and SETTLED after a release', async () => {
    const { transactionId } = await legacyResolved('LOGISTICS');
    const runtime = harness.prisma.client;
    const write = (sql: string) =>
      runUnscoped('the suite writes past the service, as a defect would', () =>
        runtime.$executeRawUnsafe(sql, transactionId),
      );

    await expect(write(RELEASE_HOLD)).rejects.toThrow(
      /trg_wallet_hold_release_settlement_authority|released to the payee only/,
    );
    await expect(
      write(`UPDATE "transaction" SET status = 'SETTLED' WHERE id = $1`),
    ).rejects.toThrow(/trg_transaction_settlement_authority|settles only once/);

    // Settlement releases the hold before it moves the transaction: with the
    // hold already RELEASED (planted with its guard lifted), SETTLED is still refused.
    await owner
      .$transaction(async (tx) => {
        // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this owner transaction.
        await tx.$executeRawUnsafe(
          'ALTER TABLE wallet_hold DISABLE TRIGGER trg_wallet_hold_release_settlement_authority',
        );
        await tx.$executeRawUnsafe(RELEASE_HOLD, transactionId);
        await expect(
          tx.$executeRawUnsafe(
            `UPDATE "transaction" SET status = 'SETTLED' WHERE id = $1`,
            transactionId,
          ),
        ).rejects.toThrow(/trg_transaction_settlement_authority|settles only once/);
        throw new Error('rolled back: the probe keeps nothing');
      })
      .catch((error: Error) => {
        if (!error.message.startsWith('rolled back')) throw error;
      });
    expect(await moneyOf(transactionId)).toEqual(legacyShape);
  });

  it('the reconciliation returns the unauthorised to HELD, keeps the proven authorised settleable, and down undoes it', async () => {
    const resolvedOrder = await legacyResolved('ORDER');
    const resolvedLogistics = await legacyResolved('LOGISTICS');
    const authorisedLegacy = await legacyAuthorised();
    // Authorised as today records it, and an obligation with no escrow: not touched.
    const authorisedNow = await held('LOGISTICS');
    await request(http)
      .post(`/v1/transactions/${authorisedNow.transactionId}/authorise-settlement`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('sta-auth'))
      .expect(200);
    const unheld = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', id('sta-unheld'))
      .send({
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '5000',
        currency: 'IRR',
      })
      .expect(201);
    planted.push(unheld.body.id as string);
    await request(http)
      .post(`/v1/transactions/${unheld.body.id}/authorise-settlement`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('sta-unheld-auth'))
      .expect(200);
    // As a pre-20260926120000 row: no instant recorded, nothing held.
    await owner.$executeRawUnsafe(
      'UPDATE "transaction" SET settlement_authorised_at = NULL WHERE id = $1',
      unheld.body.id,
    );

    // As the migration runs it: filled, and frozen afterwards (its guard
    // lifted here because the table already exists); twice, to show a re-run
    // changes nothing.
    for (let run = 0; run < 2; run += 1) {
      await owner.$transaction(async (tx) => {
        // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this owner transaction.
        await tx.$executeRawUnsafe(
          'ALTER TABLE settlement_authority_reconciliation DISABLE TRIGGER trg_settlement_authority_reconciliation_frozen',
        );
        await tx.$executeRawUnsafe(RECONCILE_INSERT);
        await tx.$executeRawUnsafe(RECONCILE_UPDATE);
        await tx.$executeRawUnsafe(
          'ALTER TABLE settlement_authority_reconciliation ENABLE TRIGGER trg_settlement_authority_reconciliation_frozen',
        );
      });
    }

    const outcomes = await owner.$queryRawUnsafe<{ transaction_id: string; outcome: string }[]>(
      'SELECT transaction_id, outcome FROM settlement_authority_reconciliation WHERE transaction_id = ANY($1::text[]) ORDER BY outcome, transaction_id',
      [
        resolvedOrder.transactionId,
        resolvedLogistics.transactionId,
        authorisedLegacy,
        authorisedNow.transactionId,
        unheld.body.id as string,
      ],
    );
    expect(outcomes).toEqual([
      { transaction_id: authorisedLegacy, outcome: 'AUTHORISED_UNRECORDED' },
      ...[resolvedOrder.transactionId, resolvedLogistics.transactionId]
        .sort()
        .map((transaction_id) => ({ transaction_id, outcome: 'RETURNED_TO_HELD' })),
    ]);
    for (const { transactionId } of [resolvedOrder, resolvedLogistics]) {
      expect(await moneyOf(transactionId)).toMatchObject({
        status: 'HELD',
        holds: ['ACTIVE'],
        settlements: 0,
      });
    }

    // The frozen table takes no new authority from anyone, the runtime included.
    await expect(
      runUnscoped('the suite tries to grant itself authority', () =>
        harness.prisma.client.$executeRawUnsafe(
          `INSERT INTO settlement_authority_reconciliation (transaction_id, outcome) VALUES ($1, 'AUTHORISED_UNRECORDED')`,
          resolvedLogistics.transactionId,
        ),
      ),
    ).rejects.toThrow(/fixed by its migration/);

    // One of them is disputed again since, and resolved (back to HELD, as
    // today's release resolves it): down must leave that one alone.
    await request(http)
      .post(`/v1/transactions/${resolvedLogistics.transactionId}/dispute`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('sta-dispute-again'))
      .send({ reason: 'A second objection, after the upgrade.' })
      .expect(200);
    const again = await request(http)
      .post(`/v1/transactions/${resolvedLogistics.transactionId}/resolve-dispute`)
      .set('authorization', asSystemAdmin())
      .set('idempotency-key', id('sta-resolve-again'))
      .send({ resolution: 'The second objection is unfounded.' })
      .expect(200);
    expect(again.body.status).toBe('HELD');

    // Down, verbatim, inside a transaction that is then rolled back: it puts
    // back exactly the row it returned to HELD that nothing touched since.
    await owner
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(DOWN_UPDATE);
        const back = await tx.$queryRawUnsafe<{ id: string; status: string }[]>(
          `SELECT id, status::text FROM "transaction" WHERE id = ANY($1::text[])`,
          [resolvedOrder.transactionId, resolvedLogistics.transactionId],
        );
        expect(Object.fromEntries(back.map((row) => [row.id, row.status]))).toEqual({
          [resolvedOrder.transactionId]: 'PENDING_SETTLEMENT',
          [resolvedLogistics.transactionId]: 'HELD',
        });
        throw new Error('rolled back: down is only probed');
      })
      .catch((error: Error) => {
        if (!error.message.startsWith('rolled back')) throw error;
      });

    // What can be proven authorised settles; so does what holds nothing.
    for (const transactionId of [
      authorisedLegacy,
      authorisedNow.transactionId,
      unheld.body.id as string,
    ]) {
      expect((await settleAsPayer(transactionId)).status).toBe(201);
      expect(await moneyOf(transactionId)).toMatchObject({ status: 'SETTLED', settlements: 1 });
    }
    // What was returned to HELD settles only after its authorisation: the
    // saga's, for the order, after the buyer's receipt.
    const early = await sagaCall('/v1/settlements', `order:${resolvedOrder.orderId}:settle`, {
      transactionId: resolvedOrder.transactionId,
    });
    expect(early.status).toBe(409);
    expect(
      (
        await sagaCall(
          `/v1/transactions/${resolvedOrder.transactionId}/authorise-settlement`,
          `order:${resolvedOrder.orderId}:authorise`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await sagaCall('/v1/settlements', `order:${resolvedOrder.orderId}:settle:2`, {
          transactionId: resolvedOrder.transactionId,
        })
      ).status,
    ).toBe(201);
    expect(await moneyOf(resolvedOrder.transactionId)).toMatchObject({
      status: 'SETTLED',
      authorised: true,
      holds: ['RELEASED'],
      journals: ['FUNDS_HELD', 'SETTLEMENT'],
      settlements: 1,
    });
  });
});
