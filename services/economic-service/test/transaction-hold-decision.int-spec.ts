import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { createSystemContext, runUnscoped, runWithContext } from '@rasta/nest-common';
import { PrismaClient } from '../src/generated/prisma';
import { admin, apiTenant, internalToken, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id, ownerDatabaseUrl } from './helpers';
import type { ExtendedPrismaClient } from '../src/prisma/prisma.service';
import { WalletRepository } from '../src/wallet/wallet.repository';
import { WalletService } from '../src/wallet/wallet.service';

/**
 * A decision read from a hold not its own proves nothing until a person has decided it
 * (FU-138; #762 r3, F2; migration 20261106120000_transaction_hold_decision).
 *
 * The real API on the real database, as the runtime role. The owner connection only plants
 * what the frozen lists hold and the hand-written holds no service places, and is the operator.
 */
jest.setTimeout(120_000);

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

const AMOUNT = 7000n;
const UNRESOLVED = [
  'HELD_UNPROVEN',
  'RETURNED_TO_HELD_UNPROVEN',
  'AUTHORISED_UNRECORDED_UNPROVEN',
  'DISPUTE_RESOLVED_UNPROVEN',
] as const;
const RELEASE_REFUSED = /trg_wallet_hold_release_settlement_authority|released to the payee only/;
const SETTLE_REFUSED = /settles only once an operator has decided it/;
const PAYMENT_REFUSED = /authorises no payment/;

describe('an unresolved hold decision proves nothing (FU-138, #762 r3 F2; real database)', () => {
  let harness: ApiHarness;
  let http: Server;
  let owner: PrismaClient;
  let walletId: string;
  const planted: string[] = [];

  const payer = apiTenant('THD-PAYER');
  const payee = apiTenant('THD-PAYEE');
  const stranger = apiTenant('THD-OTHER');

  const asPayer = () => `Bearer ${admin(payer)}`;
  const asPayee = () => `Bearer ${admin(payee)}`;

  /** `act` with one trigger lifted, in one owner transaction, restored on every exit path. */
  const lifted = (table: string, trigger: string, act: (tx: Tx) => Promise<unknown>) =>
    owner.$transaction(async (tx) => {
      // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this owner transaction.
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      await act(tx);
      // ISOLATION-ALLOW-UNBOUNDED: as above.
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    });

  const listed = (transactionId: string, outcome: string) =>
    lifted('transaction_hold_reconciliation', 'trg_transaction_hold_reconciliation_frozen', (tx) =>
      tx.$executeRawUnsafe(
        'INSERT INTO transaction_hold_reconciliation (transaction_id, outcome) VALUES ($1, $2)',
        transactionId,
        outcome,
      ),
    );

  /** The frozen authorisation of 20261103121000's backfill. */
  const recordedAuthorised = (transactionId: string) =>
    lifted(
      'settlement_authority_reconciliation',
      'trg_settlement_authority_reconciliation_frozen',
      (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO settlement_authority_reconciliation (transaction_id, outcome) VALUES ($1, 'AUTHORISED_UNRECORDED')`,
          transactionId,
        ),
    );

  /** Escrowed through the service: HELD, with the payer's own hold. */
  async function escrowed(): Promise<string> {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', id('thd-hold'))
      .send({
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: payee,
        grossAmountMinor: AMOUNT.toString(),
        currency: 'IRR',
        holdFunds: true,
      })
      .expect(201);
    expect(created.body.status).toBe('HELD');
    planted.push(created.body.id as string);
    return created.body.id as string;
  }

  /** No hold of its own in any status, standing in `status`. */
  async function bare(status: string): Promise<string> {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', id('thd-bare'))
      .send({
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: payee,
        grossAmountMinor: AMOUNT.toString(),
        currency: 'IRR',
      })
      .expect(201);
    const transactionId = created.body.id as string;
    planted.push(transactionId);
    await owner.$executeRawUnsafe(
      `UPDATE "transaction" SET status = $2::"TransactionStatus" WHERE id = $1`,
      transactionId,
      status,
    );
    return transactionId;
  }

  /** A hold written by hand: no service route places one on an existing transaction. */
  const handHold = (transactionId: string, amount = AMOUNT, currency = 'IRR') =>
    owner.$executeRawUnsafe(
      `INSERT INTO wallet_hold (id, organization_id, wallet_id, amount_minor, currency, reference,
                                reference_type, placed_at, placed_by)
       VALUES ($1, $2, $3, $4, $6, $5, 'TRANSACTION', now(), 'USR-THD')`,
      `HLD_${ulid()}`,
      payer,
      walletId,
      amount,
      transactionId,
      currency,
    );

  /** The service's own hold placement, journal and escrow included: what a fresh hold is. */
  const fundedHold = (transactionId: string) =>
    runWithContext(createSystemContext({ correlationId: id('thd'), organizationId: payer }), () =>
      (harness.prisma.client as unknown as PrismaClient).$transaction(async (tx) => {
        const db = tx as unknown as ExtendedPrismaClient;
        const [wallet] = await harness.app.get(WalletRepository).lock(db, [walletId]);
        await harness.app.get(WalletService).placeHold(db, {
          wallet: wallet!,
          amountMinor: AMOUNT,
          reference: transactionId,
          referenceType: 'TRANSACTION',
          transactionId,
          placedBy: 'USR-THD',
        });
      }),
    );

  const setStatus = (transactionId: string, status: string) =>
    owner.$executeRawUnsafe(
      `UPDATE "transaction" SET status = $2::"TransactionStatus" WHERE id = $1`,
      transactionId,
      status,
    );

  const decide = (transactionId: string, decision: string, reason = 'decided from the ticket') =>
    owner.$queryRawUnsafe<{ status: string }[]>(
      'SELECT decide_transaction_hold($1, $2, $3) AS status',
      transactionId,
      decision,
      reason,
    );

  const asRuntime = <T>(act: (client: PrismaClient) => Promise<T>) =>
    runUnscoped('the suite goes at the database as the service’s runtime role', () =>
      act(harness.prisma.client as unknown as PrismaClient),
    );

  const authorised = async (transactionId: string) => {
    const [row] = await asRuntime((client) =>
      client.$queryRawUnsafe<{ authorised: boolean }[]>(
        `SELECT transaction_settlement_authorised(id, settlement_authorised_at IS NOT NULL) AS authorised
           FROM "transaction" WHERE id = $1`,
        transactionId,
      ),
    );
    return row!.authorised;
  };

  const barred = async (transactionId: string) => {
    const [row] = await asRuntime((client) =>
      client.$queryRawUnsafe<{ barred: boolean }[]>(
        'SELECT transaction_settlement_barred($1) AS barred',
        transactionId,
      ),
    );
    return row!.barred;
  };

  const detail = async (transactionId: string, authorization = asPayer()) =>
    (
      await request(http)
        .get(`/v1/transactions/${transactionId}`)
        .set('authorization', authorization)
        .expect(200)
    ).body as { status: string; heldProven: boolean };

  const listedRow = async (transactionId: string, authorization = asPayer(), query = '') => {
    const page = await request(http)
      .get(`/v1/transactions?limit=100${query}`)
      .set('authorization', authorization)
      .expect(200);
    return (page.body.items as { id: string; heldProven: boolean }[]).find(
      (item) => item.id === transactionId,
    );
  };

  const provenEverywhere = async (transactionId: string) => {
    const [read, row] = [await detail(transactionId), await listedRow(transactionId)];
    expect(row?.heldProven).toBe(read.heldProven);
    return read.heldProven;
  };

  const settle = (transactionId: string) =>
    request(http)
      .post('/v1/settlements')
      .set('authorization', asPayer())
      .set('idempotency-key', id('thd-settle'))
      .send({ transactionId });

  const money = (transactionId: string) =>
    asRuntime(async (client) => ({
      status: (
        await client.transaction.findUniqueOrThrow({
          where: { id: transactionId },
          select: { status: true },
        })
      ).status,
      holds: (
        await client.walletHold.findMany({
          where: { reference: transactionId, referenceType: 'TRANSACTION' },
          select: { status: true },
        })
      ).map((hold) => hold.status),
      settlements: await client.settlement.count({ where: { transactionId } }),
    }));

  /** A release as complete as settlement writes it, so only authority refuses it. */
  const releaseAsRuntime = (transactionId: string) =>
    asRuntime((client) =>
      client.$executeRawUnsafe(
        `UPDATE wallet_hold
            SET status = 'RELEASED', resolved_at = now(), resolved_by = 'USR-THD',
                resolved_journal_id = placed_journal_id
          WHERE reference = $1 AND reference_type = 'TRANSACTION'`,
        transactionId,
      ),
    );

  const settledAsRuntime = (transactionId: string) =>
    asRuntime((client) =>
      client.$executeRawUnsafe(
        `UPDATE "transaction" SET status = 'SETTLED' WHERE id = $1`,
        transactionId,
      ),
    );

  const authorise = (transactionId: string) =>
    request(http)
      .post(`/v1/transactions/${transactionId}/authorise-settlement`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('thd-authorise'))
      .expect(200);

  /** Refused by the service and, behind it, by the database, with a balance that could pay it. */
  const expectPaysNothing = async (transactionId: string) => {
    const before = await money(transactionId);
    expect((await settle(transactionId)).status).toBe(409);
    await expect(settledAsRuntime(transactionId)).rejects.toThrow(
      /authorises no payment|settles only once an operator/,
    );
    expect(await money(transactionId)).toEqual(before);
  };

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asPayer());
    walletId = wallet.body.id as string;
    await request(http)
      .post(`/v1/wallets/${walletId}/top-up`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('thd-fund'))
      .send({ amountMinor: '50000000' })
      .expect(201);
    await request(http).get('/v1/wallets/me').set('authorization', asPayee()).expect(200);
  });

  afterAll(async () => {
    // The lists are frozen and the decisions append-only: this suite's own rows go with
    // the guards lifted, in one owner transaction, or its transactions could not.
    await owner.$transaction(async (tx) => {
      for (const [table, trigger] of [
        ['transaction_hold_decision', 'trg_transaction_hold_decision_guard'],
        ['transaction_hold_reconciliation', 'trg_transaction_hold_reconciliation_frozen'],
        ['settlement_authority_reconciliation', 'trg_settlement_authority_reconciliation_frozen'],
      ] as const) {
        // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this owner transaction.
        await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
        await tx.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE transaction_id = ANY($1::text[])`,
          planted,
        );
        // ISOLATION-ALLOW-UNBOUNDED: as above.
        await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      }
    });
    await owner.$disconnect();
    await cleanup(harness.prisma, [payer, payee, stranger]);
    await harness.close();
  });

  describe('what HELD says, at the API', () => {
    it('a transaction escrowed through the service is proven, to its payer and its payee', async () => {
      const transactionId = await escrowed();
      expect(await provenEverywhere(transactionId)).toBe(true);
      expect((await detail(transactionId, asPayee())).heldProven).toBe(true);
      expect((await listedRow(transactionId, asPayee(), '&includeIncoming=true'))?.heldProven).toBe(
        true,
      );
    });

    it.each(['HELD_UNPROVEN', 'RETURNED_TO_HELD_UNPROVEN'])(
      '%s: still HELD, and not proven, on the detail and in the list',
      async (outcome) => {
        const transactionId = await bare('HELD');
        await listed(transactionId, outcome);
        expect((await detail(transactionId)).status).toBe('HELD');
        expect(await provenEverywhere(transactionId)).toBe(false);
      },
    );

    it('HELD with no hold at all and on no list is not proven either', async () => {
      const transactionId = await bare('HELD');
      expect(await provenEverywhere(transactionId)).toBe(false);
    });

    it.each(UNRESOLVED)(
      '%s with its own real hold: not proven until it is decided',
      async (outcome) => {
        const transactionId = await escrowed();
        await listed(transactionId, outcome);
        expect(await provenEverywhere(transactionId)).toBe(false);
        expect(await barred(transactionId)).toBe(true);
        await decide(transactionId, 'CONFIRMED');
        expect(await provenEverywhere(transactionId)).toBe(true);
        expect(await barred(transactionId)).toBe(false);
      },
    );

    it('RESTORED_TO_PENDING_SETTLEMENT is no unresolved decision: its real hold proves it', async () => {
      const transactionId = await escrowed();
      await listed(transactionId, 'RESTORED_TO_PENDING_SETTLEMENT');
      expect(await provenEverywhere(transactionId)).toBe(true);
    });

    it('a hold for less than the gross, or a released one, proves nothing', async () => {
      const short = await bare('HELD');
      await handHold(short, AMOUNT - 1n);
      expect(await provenEverywhere(short)).toBe(false);

      const released = await escrowed();
      await request(http)
        .post(`/v1/transactions/${released}/authorise-settlement`)
        .set('authorization', asPayer())
        .set('idempotency-key', id('thd-auth'))
        .expect(200);
      await settle(released).expect(201);
      // The row's own status is not what speaks here: back in HELD by hand, nothing is held.
      await lifted('"transaction"', 'trg_transaction_status_edges', (tx) =>
        tx.$executeRawUnsafe(`UPDATE "transaction" SET status = 'HELD' WHERE id = $1`, released),
      );
      expect((await detail(released)).heldProven).toBe(false);
    });

    it('any other status is not proven, its hold in place or not', async () => {
      const transactionId = await escrowed();
      await setStatus(transactionId, 'PENDING_SETTLEMENT');
      expect((await money(transactionId)).holds).toEqual(['ACTIVE']);
      expect(await provenEverywhere(transactionId)).toBe(false);
      // The database's own answer, not only that the service does not ask it there.
      const [row] = await asRuntime((client) =>
        client.$queryRawUnsafe<{ proven: boolean }[]>(
          'SELECT transaction_held_proven($1) AS proven',
          transactionId,
        ),
      );
      expect(row!.proven).toBe(false);
    });

    it('another organization reads none of it: 404, and not in its list', async () => {
      const transactionId = await bare('HELD');
      await listed(transactionId, 'HELD_UNPROVEN');
      const asStranger = `Bearer ${admin(stranger)}`;
      await request(http)
        .get(`/v1/transactions/${transactionId}`)
        .set('authorization', asStranger)
        .expect(404);
      expect(await listedRow(transactionId, asStranger, '&includeIncoming=true')).toBeUndefined();
    });
  });

  // #824 r1, F3: what the order saga asks before any order's work.
  it('says it proves HELD, to marketplace-service and no other service', async () => {
    // Of no organization: the saga starter's sweep has none to name.
    const asked = async (caller: string) =>
      request(http)
        .get('/v1/transactions/capabilities')
        .set('x-internal-token', await internalToken(caller));
    const answer = await asked('marketplace-service');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ heldProven: true });
    expect((await asked('contract-service')).status).toBe(403);
  });

  describe('authorization predicates, with a later own hold', () => {
    async function legacyAuthorisedWithHold(): Promise<string> {
      const transactionId = await escrowed();
      await setStatus(transactionId, 'PENDING_SETTLEMENT');
      await recordedAuthorised(transactionId);
      return transactionId;
    }

    it('control: the frozen authorisation of a row on no list still authorises, and settles', async () => {
      const transactionId = await legacyAuthorisedWithHold();
      expect(await authorised(transactionId)).toBe(true);
      await settle(transactionId).expect(201);
      expect(await money(transactionId)).toEqual({
        status: 'SETTLED',
        holds: ['RELEASED'],
        settlements: 1,
      });
    });

    it('control: nor does the restored outcome take a recorded authorisation away', async () => {
      const transactionId = await legacyAuthorisedWithHold();
      await listed(transactionId, 'RESTORED_TO_PENDING_SETTLEMENT');
      expect(await authorised(transactionId)).toBe(true);
      await settle(transactionId).expect(201);
    });

    it.each(UNRESOLVED)(
      '%s authorises nothing: not the service, not the release, not SETTLED',
      async (outcome) => {
        const transactionId = await legacyAuthorisedWithHold();
        await listed(transactionId, outcome);
        const before = await money(transactionId);
        expect(before).toEqual({
          status: 'PENDING_SETTLEMENT',
          holds: ['ACTIVE'],
          settlements: 0,
        });

        expect(await authorised(transactionId)).toBe(false);
        const refused = await settle(transactionId);
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('INVALID_STATE_TRANSITION');
        await expect(releaseAsRuntime(transactionId)).rejects.toThrow(RELEASE_REFUSED);
        await expect(settledAsRuntime(transactionId)).rejects.toThrow(SETTLE_REFUSED);
        expect(await money(transactionId)).toEqual(before);
      },
    );

    it('nor does the column open it: a real authorisation waits for the decision too', async () => {
      const transactionId = await escrowed();
      await listed(transactionId, 'HELD_UNPROVEN');
      await request(http)
        .post(`/v1/transactions/${transactionId}/authorise-settlement`)
        .set('authorization', asPayer())
        .set('idempotency-key', id('thd-auth-real'))
        .expect(200);
      expect(await authorised(transactionId)).toBe(false);
      expect((await settle(transactionId)).status).toBe(409);
      await expect(releaseAsRuntime(transactionId)).rejects.toThrow(RELEASE_REFUSED);

      await decide(transactionId, 'CONFIRMED');
      expect(await authorised(transactionId)).toBe(true);
      await settle(transactionId).expect(201);
    });

    it('a resolved dispute goes where the unproven authority leaves it: back to HELD, and the database says so', async () => {
      const proven = await legacyAuthorisedWithHold();
      const unproven = await legacyAuthorisedWithHold();
      await listed(unproven, 'AUTHORISED_UNRECORDED_UNPROVEN');
      for (const transactionId of [proven, unproven]) {
        await request(http)
          .post(`/v1/transactions/${transactionId}/dispute`)
          .set('authorization', asPayer())
          .set('idempotency-key', id('thd-dispute'))
          .send({ reason: 'The invoice names another supplier.' })
          .expect(200);
      }
      await expect(
        asRuntime((client) =>
          client.$executeRawUnsafe(
            `UPDATE "transaction" SET status = 'PENDING_SETTLEMENT' WHERE id = $1`,
            unproven,
          ),
        ),
      ).rejects.toThrow(/trg_transaction_dispute_resolution|where its settlement authority stands/);

      const resolve = (transactionId: string) =>
        request(http)
          .post(`/v1/transactions/${transactionId}/resolve-dispute`)
          .set('authorization', `Bearer ${admin(apiTenant('THD-PLATFORM'), ['SYSTEM_ADMIN'])}`)
          .set('idempotency-key', id('thd-resolve'))
          .send({ resolution: 'The objection is unfounded.' })
          .expect(200);
      expect((await resolve(proven)).body.status).toBe('PENDING_SETTLEMENT');
      expect((await resolve(unproven)).body.status).toBe('HELD');
    });

    it('nothing held and unresolved settles neither: the spendable balance is not the way round', async () => {
      const transactionId = await bare('PENDING_SETTLEMENT');
      await listed(transactionId, 'DISPUTE_RESOLVED_UNPROVEN');
      expect((await settle(transactionId)).status).toBe(409);
      await expect(settledAsRuntime(transactionId)).rejects.toThrow(SETTLE_REFUSED);
      expect((await money(transactionId)).settlements).toBe(0);

      // D-123: a decision is the evidence's. It opens no spendable balance.
      await decide(transactionId, 'CONFIRMED');
      expect((await settle(transactionId)).status).toBe(409);
      await expect(settledAsRuntime(transactionId)).rejects.toThrow(PAYMENT_REFUSED);
      expect(await money(transactionId)).toEqual({
        status: 'PENDING_SETTLEMENT',
        holds: [],
        settlements: 0,
      });
    });

    it('a refund stays open while it is unresolved: the payer’s own hold goes back to the payer', async () => {
      const transactionId = await legacyAuthorisedWithHold();
      await listed(transactionId, 'AUTHORISED_UNRECORDED_UNPROVEN');
      await request(http)
        .post(`/v1/transactions/${transactionId}/refund`)
        .set('authorization', `Bearer ${admin(payee)}`)
        .set('idempotency-key', id('thd-refund'))
        .send({ reason: 'The supplier returns the money.' })
        .expect(200);
      expect(await money(transactionId)).toEqual({
        status: 'REFUNDED',
        holds: ['REFUNDED'],
        settlements: 0,
      });
    });
  });

  describe('the operator’s decision', () => {
    it('CONFIRMED lets a frozen authorisation count again; VOIDED ends it for good', async () => {
      const confirmed = await escrowed();
      const voided = await escrowed();
      for (const transactionId of [confirmed, voided]) {
        await setStatus(transactionId, 'PENDING_SETTLEMENT');
        await recordedAuthorised(transactionId);
        await listed(transactionId, 'AUTHORISED_UNRECORDED_UNPROVEN');
      }
      await decide(confirmed, 'CONFIRMED');
      expect(await authorised(confirmed)).toBe(true);
      await settle(confirmed).expect(201);

      await decide(voided, 'VOIDED');
      expect(await authorised(voided)).toBe(false);
      expect((await settle(voided)).status).toBe(409);
      await expect(releaseAsRuntime(voided)).rejects.toThrow(RELEASE_REFUSED);
      await expect(settledAsRuntime(voided)).rejects.toThrow(/once its settlement is authorised/);
      expect((await money(voided)).holds).toEqual(['ACTIVE']);
    });

    it('VOIDED disposes of the evidence only: the row stays HELD, unproven, and nothing pays it (D-123)', async () => {
      const transactionId = await bare('HELD');
      await listed(transactionId, 'HELD_UNPROVEN');
      const journals = () =>
        owner.$queryRawUnsafe<unknown[]>(
          'SELECT id FROM journal WHERE transaction_id = $1',
          transactionId,
        );
      const before = await journals();

      const [answer] = await decide(transactionId, 'VOIDED', '  nothing backs this row  ');

      expect(answer!.status).toBe('HELD');
      expect(await detail(transactionId)).toMatchObject({ status: 'HELD', heldProven: false });
      expect(await journals()).toEqual(before);
      const [row] = await owner.$queryRawUnsafe<
        { decision: string; reason: string; decided_by: string; session: string }[]
      >(
        `SELECT decision, reason, decided_by, session_user AS session
           FROM transaction_hold_decision WHERE transaction_id = $1`,
        transactionId,
      );
      expect(row).toMatchObject({ decision: 'VOIDED', reason: 'nothing backs this row' });
      expect(row!.decided_by).toBe(row!.session);

      // Not by the status either: authorised onward, it still debits nobody's spendable balance.
      await authorise(transactionId);
      expect(await detail(transactionId)).toMatchObject({ status: 'PENDING_SETTLEMENT' });
      await expectPaysNothing(transactionId);
    });

    // CONFIRMED of the two HELD outcomes needs the hold itself (the refusals below).
    it.each<[string, string]>([
      ...UNRESOLVED.map((outcome): [string, string] => [outcome, 'VOIDED']),
      ['AUTHORISED_UNRECORDED_UNPROVEN', 'CONFIRMED'],
      ['DISPUTE_RESOLVED_UNPROVEN', 'CONFIRMED'],
    ])(
      'already PENDING_SETTLEMENT, %s, %s, nothing held: nothing pays it',
      async (outcome, decision) => {
        const transactionId = await bare('PENDING_SETTLEMENT');
        await listed(transactionId, outcome);
        await recordedAuthorised(transactionId);
        await decide(transactionId, decision);
        await expectPaysNothing(transactionId);
      },
    );

    it.each(['VOIDED', 'undecided'])(
      'DISPUTED with no own hold, %s, resolves to HELD: not settlement-ready, and nothing pays it',
      async (decision) => {
        const transactionId = await bare('HELD');
        await listed(transactionId, 'DISPUTE_RESOLVED_UNPROVEN');
        await request(http)
          .post(`/v1/transactions/${transactionId}/dispute`)
          .set('authorization', asPayer())
          .set('idempotency-key', id('thd-void-dispute'))
          .send({ reason: 'The invoice names another supplier.' })
          .expect(200);
        if (decision === 'VOIDED') await decide(transactionId, decision);
        await expect(
          asRuntime((client) =>
            client.$executeRawUnsafe(
              `UPDATE "transaction" SET status = 'PENDING_SETTLEMENT' WHERE id = $1`,
              transactionId,
            ),
          ),
        ).rejects.toThrow(
          /trg_transaction_dispute_resolution|where its settlement authority stands/,
        );
        const resolved = await request(http)
          .post(`/v1/transactions/${transactionId}/resolve-dispute`)
          .set('authorization', `Bearer ${admin(apiTenant('THD-PLATFORM'), ['SYSTEM_ADMIN'])}`)
          .set('idempotency-key', id('thd-void-resolve'))
          .send({ resolution: 'The objection is unfounded.' })
          .expect(200);
        expect(resolved.body).toMatchObject({ status: 'HELD', heldProven: false });
        await authorise(transactionId);
        await expectPaysNothing(transactionId);
      },
    );

    it('a voided row with a fresh hold of its own for its terms is proven and settles like any row', async () => {
      const transactionId = await bare('HELD');
      await listed(transactionId, 'HELD_UNPROVEN');
      await decide(transactionId, 'VOIDED');
      await expectPaysNothing(transactionId);

      await fundedHold(transactionId);
      expect(await provenEverywhere(transactionId)).toBe(true);
      // Held is not authorised: that stays its own step.
      await expect(releaseAsRuntime(transactionId)).rejects.toThrow(RELEASE_REFUSED);
      await authorise(transactionId);
      await settle(transactionId).expect(201);
      expect(await money(transactionId)).toEqual({
        status: 'SETTLED',
        holds: ['RELEASED'],
        settlements: 1,
      });
    });

    it.each([
      ['short of the gross', (row: string) => handHold(row, AMOUNT - 1n)],
      ['in another currency', (row: string) => handHold(row, AMOUNT, 'USD')],
    ])('a fresh hold %s opens nothing', async (_case, hold) => {
      const transactionId = await bare('HELD');
      await listed(transactionId, 'HELD_UNPROVEN');
      await decide(transactionId, 'VOIDED');
      await hold(transactionId);
      expect(await provenEverywhere(transactionId)).toBe(false);
      await authorise(transactionId);
      expect((await settle(transactionId)).status).toBe(409);
      await expect(releaseAsRuntime(transactionId)).rejects.toThrow(RELEASE_REFUSED);
      expect((await money(transactionId)).settlements).toBe(0);
    });

    it('no other RELEASED hold speaks for this settlement: the database still refuses', async () => {
      const transactionId = await bare('PENDING_SETTLEMENT');
      await listed(transactionId, 'DISPUTE_RESOLVED_UNPROVEN');
      await decide(transactionId, 'VOIDED');
      await owner.$executeRawUnsafe(
        `INSERT INTO wallet_hold (id, organization_id, wallet_id, amount_minor, currency, reference,
                                  reference_type, status, placed_at, placed_by, resolved_at,
                                  resolved_by, resolved_journal_id)
         SELECT $1, $2, $3, $4, 'IRR', $5, 'TRANSACTION', 'RELEASED', now(), 'USR-THD', now(),
                'USR-THD', j.id
           FROM journal j WHERE j.organization_id = $2 LIMIT 1`,
        `HLD_${ulid()}`,
        payer,
        walletId,
        AMOUNT,
        transactionId,
      );
      await expect(settledAsRuntime(transactionId)).rejects.toThrow(PAYMENT_REFUSED);
    });

    it('a voided row with nothing held refunds with no money moved: the way out', async () => {
      const transactionId = await bare('HELD');
      await listed(transactionId, 'HELD_UNPROVEN');
      await decide(transactionId, 'VOIDED');
      await request(http)
        .post(`/v1/transactions/${transactionId}/refund`)
        .set('authorization', asPayee())
        .set('idempotency-key', id('thd-void-refund'))
        .send({ reason: 'Nothing backs this obligation.' })
        .expect(200);
      expect(await money(transactionId)).toEqual({
        status: 'REFUNDED',
        holds: [],
        settlements: 0,
      });
    });

    it('control: a row on no list, and a restored one, still pay with nothing held (ADR-032)', async () => {
      const unlisted = await bare('PENDING_SETTLEMENT');
      await settle(unlisted).expect(201);
      const restored = await bare('PENDING_SETTLEMENT');
      await listed(restored, 'RESTORED_TO_PENDING_SETTLEMENT');
      await settle(restored).expect(201);
    });

    it.each([
      [
        'authorised since',
        (transactionId: string) =>
          request(http)
            .post(`/v1/transactions/${transactionId}/authorise-settlement`)
            .set('authorization', asPayer())
            .set('idempotency-key', id('thd-moved-auth'))
            .expect(200),
        'PENDING_SETTLEMENT',
      ],
      [
        'disputed since',
        (transactionId: string) =>
          request(http)
            .post(`/v1/transactions/${transactionId}/dispute`)
            .set('authorization', asPayer())
            .set('idempotency-key', id('thd-moved-dispute'))
            .send({ reason: 'The invoice names another supplier.' })
            .expect(200),
        'DISPUTED',
      ],
    ])(
      'moving a row found HELD does not get CONFIRMED round its missing hold: %s',
      async (_case, move, status) => {
        const transactionId = await bare('HELD');
        await listed(transactionId, 'HELD_UNPROVEN');
        await move(transactionId);
        expect((await detail(transactionId)).status).toBe(status);

        await expect(decide(transactionId, 'CONFIRMED')).rejects.toThrow(
          /confirmed only by its own active hold/,
        );
        expect((await settle(transactionId)).status).toBe(409);

        // VOIDED answers it, and its status stays where the move left it.
        const [answer] = await decide(transactionId, 'VOIDED');
        expect(answer!.status).toBe(status);
      },
    );

    it('a hold short of the gross has one way out, the runbook’s: refund, then CONFIRMED', async () => {
      const transactionId = await bare('HELD');
      await listed(transactionId, 'HELD_UNPROVEN');
      await handHold(transactionId, AMOUNT - 1n);
      await expect(decide(transactionId, 'VOIDED')).rejects.toThrow(/active hold of its own/);
      await request(http)
        .post(`/v1/transactions/${transactionId}/refund`)
        .set('authorization', asPayee())
        .set('idempotency-key', id('thd-short-refund'))
        .send({ reason: 'The supplier returns the money.' })
        .expect(200);
      const [answer] = await decide(transactionId, 'CONFIRMED');
      expect(answer!.status).toBe('REFUNDED');
    });

    it('with a decision in flight, a settlement waits for it and moves nothing on what it voided', async () => {
      const transactionId = await escrowed();
      await setStatus(transactionId, 'PENDING_SETTLEMENT');
      await recordedAuthorised(transactionId);
      await listed(transactionId, 'AUTHORISED_UNRECORDED_UNPROVEN');

      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let decided!: () => void;
      const inFlight = new Promise<void>((resolve) => {
        decided = resolve;
      });
      const decision = owner.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            'SELECT decide_transaction_hold($1, $2, $3)',
            transactionId,
            'VOIDED',
            'decided from the ticket',
          );
          decided();
          await released;
        },
        { timeout: 30_000 },
      );
      await inFlight;

      let answered = false;
      const attempt = settle(transactionId).then((response) => {
        answered = true;
        return response;
      });
      // Not a sleep to pass, but a bound on a wait that must not end by itself.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(answered).toBe(false);

      release();
      await decision;
      const refused = await attempt;
      expect(refused.status).toBe(409);
      expect(await money(transactionId)).toEqual({
        status: 'PENDING_SETTLEMENT',
        holds: ['ACTIVE'],
        settlements: 0,
      });
    });

    it('CONFIRMED on a row that has moved on changes nothing but the record', async () => {
      const transactionId = await bare('REFUNDED');
      await listed(transactionId, 'DISPUTE_RESOLVED_UNPROVEN');
      const [answer] = await decide(transactionId, 'CONFIRMED');
      expect(answer!.status).toBe('REFUNDED');
    });

    it.each<[string, string, (row: string) => Promise<unknown>, RegExp]>([
      [
        'CONFIRMED with nothing held',
        'CONFIRMED',
        async () => {},
        /confirmed only by its own active hold/,
      ],
      [
        'CONFIRMED on a hold short of the gross',
        'CONFIRMED',
        (row) => handHold(row, AMOUNT - 1n),
        /confirmed only by its own active hold/,
      ],
      [
        'VOIDED with a hold of its own',
        'VOIDED',
        (row) => handHold(row),
        /has an active hold of its own/,
      ],
      ['an unknown word', 'MAYBE', async () => {}, /ck_transaction_hold_decision_decision/],
    ])('refuses %s, and nothing is recorded', async (_case, decision, prepare, refusal) => {
      const transactionId = await bare('HELD');
      await listed(transactionId, 'HELD_UNPROVEN');
      await prepare(transactionId);
      await expect(decide(transactionId, decision)).rejects.toThrow(refusal);
      const rows = await owner.$queryRawUnsafe<unknown[]>(
        'SELECT 1 FROM transaction_hold_decision WHERE transaction_id = $1',
        transactionId,
      );
      expect(rows).toEqual([]);
      expect((await detail(transactionId)).status).toBe('HELD');
    });

    it('refuses an empty reason', async () => {
      const transactionId = await bare('PENDING_SETTLEMENT');
      await listed(transactionId, 'DISPUTE_RESOLVED_UNPROVEN');
      await expect(decide(transactionId, 'CONFIRMED', '   short  ')).rejects.toThrow(
        /ck_transaction_hold_decision_reason/,
      );
    });

    it('refuses what has nothing to decide: no such row, on no list, or restored', async () => {
      await expect(decide('TXN_NO_SUCH_ROW', 'VOIDED')).rejects.toThrow(/no such transaction/);
      const unlisted = await bare('PENDING_SETTLEMENT');
      await expect(decide(unlisted, 'VOIDED')).rejects.toThrow(/no unresolved hold decision/);
      const restored = await bare('PENDING_SETTLEMENT');
      await listed(restored, 'RESTORED_TO_PENDING_SETTLEMENT');
      await expect(decide(restored, 'VOIDED')).rejects.toThrow(/no unresolved hold decision/);
    });

    it('decides once: a second decision is refused, and a decision is never changed', async () => {
      const transactionId = await bare('PENDING_SETTLEMENT');
      await listed(transactionId, 'DISPUTE_RESOLVED_UNPROVEN');
      await decide(transactionId, 'CONFIRMED');
      await expect(decide(transactionId, 'VOIDED')).rejects.toThrow(/already exists/);
      for (const sql of [
        `UPDATE transaction_hold_decision SET decision = 'VOIDED' WHERE transaction_id = '${transactionId}'`,
        `DELETE FROM transaction_hold_decision WHERE transaction_id = '${transactionId}'`,
        // ISOLATION-ALLOW-UNBOUNDED: refused by its own trigger, which is what this asserts.
        'TRUNCATE transaction_hold_decision',
      ]) {
        await expect(owner.$executeRawUnsafe(sql)).rejects.toThrow(/append-only/);
      }
    });

    it('the service’s runtime role decides nothing: no EXECUTE, and no row of its own', async () => {
      const transactionId = await bare('HELD');
      await listed(transactionId, 'HELD_UNPROVEN');
      await expect(
        asRuntime((client) =>
          client.$queryRawUnsafe(
            `SELECT decide_transaction_hold($1, 'VOIDED', 'the service decides for itself')`,
            transactionId,
          ),
        ),
      ).rejects.toThrow(/permission denied for function decide_transaction_hold/);
      await expect(
        asRuntime((client) =>
          client.$executeRawUnsafe(
            `INSERT INTO transaction_hold_decision (transaction_id, decision, reason, decided_by)
             VALUES ($1, 'CONFIRMED', 'the service decides for itself', 'rasta_economic')`,
            transactionId,
          ),
        ),
      ).rejects.toThrow(/an operator|permission denied/);
      expect(await provenEverywhere(transactionId)).toBe(false);
    });
  });
});
