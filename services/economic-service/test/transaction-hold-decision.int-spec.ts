import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { createSystemContext, runUnscoped, runWithContext } from '@rasta/nest-common';
import { PrismaClient } from '../src/generated/prisma';
import { admin, apiTenant, internalToken, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id, ownerDatabaseUrl } from './helpers';
import type { ExtendedPrismaClient } from '../src/prisma/prisma.service';
import { TransactionService } from '../src/transaction/transaction.service';
import { WalletRepository } from '../src/wallet/wallet.repository';
import { HOLD_NOT_FUNDED, WalletService } from '../src/wallet/wallet.service';

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
const PAYMENT_REFUSED = /settles only from a funded hold/;

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

  /**
   * `act` with triggers lifted, in one owner transaction, restored on every exit path. All are
   * lifted before `act`: a table with a write's deferred trigger event pending takes no ALTER.
   */
  const lifted = (table: string, trigger: string | string[], act: (tx: Tx) => Promise<unknown>) =>
    owner.$transaction(async (tx) => {
      const triggers = [trigger].flat();
      for (const name of triggers) {
        // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this owner transaction.
        await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${name}`);
      }
      await act(tx);
      for (const name of triggers) {
        // ISOLATION-ALLOW-UNBOUNDED: as above.
        await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${name}`);
      }
    });

  /** Refuses at commit any hold naming a journal that does not fund it (FU-182). */
  const AT_COMMIT = 'trg_wallet_hold_funded_at_commit';
  /** A row from before `trg_wallet_hold_inserted_only_funded`, and from before {@link AT_COMMIT}. */
  const BEFORE_FUNDED_GUARDS = ['trg_wallet_hold_inserted_only_funded', AT_COMMIT];

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

  /**
   * A hold written by hand: no service route places one on an existing transaction. One naming a
   * journal is a row from before {@link AT_COMMIT}, which refuses it unless the journal funds it.
   */
  const handHold = (
    transactionId: string,
    amount = AMOUNT,
    currency = 'IRR',
    journalId: string | null = null,
  ) =>
    lifted('wallet_hold', AT_COMMIT, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO wallet_hold (id, organization_id, wallet_id, amount_minor, currency, reference,
                                reference_type, placed_at, placed_by, placed_journal_id)
       VALUES ($1, $2, $3, $4, $6, $5, 'TRANSACTION', now(), 'USR-THD', $7)`,
        `HLD_${ulid()}`,
        payer,
        walletId,
        amount,
        transactionId,
        currency,
        journalId,
      ),
    );

  /** The service's own hold placement, journal and escrow included: what a fresh hold is. */
  const fundedHold = (transactionId: string, amount = AMOUNT) =>
    runWithContext(createSystemContext({ correlationId: id('thd'), organizationId: payer }), () =>
      (harness.prisma.client as unknown as PrismaClient).$transaction(async (tx) => {
        const db = tx as unknown as ExtendedPrismaClient;
        const [wallet] = await harness.app.get(WalletRepository).lock(db, [walletId]);
        await harness.app.get(WalletService).placeHold(db, {
          wallet: wallet!,
          amountMinor: amount,
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
      journals: await client.journal.count({ where: { transactionId } }),
      spendable: (
        await client.wallet.findUniqueOrThrow({
          where: { id: walletId },
          select: { availableBalanceMinor: true },
        })
      ).availableBalanceMinor,
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
      /settles only from a funded hold|settles only once an operator/,
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
      expect(await money(transactionId)).toMatchObject({
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
        expect(before).toMatchObject({
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
      expect(await money(transactionId)).toMatchObject({
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
      expect(await money(transactionId)).toMatchObject({
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
      expect(await money(transactionId)).toMatchObject({
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
      // A row from before `trg_wallet_hold_inserted_only_funded`.
      await lifted('wallet_hold', BEFORE_FUNDED_GUARDS, (tx) =>
        tx.$executeRawUnsafe(
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
        ),
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
      expect(await money(transactionId)).toMatchObject({
        status: 'REFUNDED',
        holds: [],
        settlements: 0,
      });
    });

    it('control: a row on no list that never claimed escrow still pays with nothing held (ADR-032)', async () => {
      const unlisted = await bare('PENDING_SETTLEMENT');
      await settle(unlisted).expect(201);
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
          /confirmed only by its own active funded hold/,
        );
        expect((await settle(transactionId)).status).toBe(409);

        // VOIDED answers it, and its status stays where the move left it.
        const [answer] = await decide(transactionId, 'VOIDED');
        expect(answer!.status).toBe(status);
      },
    );

    it('a funded hold short of the gross has one way out, the runbook’s: refund, then CONFIRMED', async () => {
      const transactionId = await bare('HELD');
      await listed(transactionId, 'HELD_UNPROVEN');
      await fundedHold(transactionId, AMOUNT - 1n);
      await expect(decide(transactionId, 'VOIDED')).rejects.toThrow(
        /active funded hold of its own/,
      );
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
      expect(await money(transactionId)).toMatchObject({
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
        /confirmed only by its own active funded hold/,
      ],
      [
        'CONFIRMED on a hold short of the gross',
        'CONFIRMED',
        (row) => handHold(row, AMOUNT - 1n),
        /confirmed only by its own active funded hold/,
      ],
      [
        'VOIDED with a funded hold of its own',
        'VOIDED',
        (row) => fundedHold(row),
        /has an active funded hold of its own/,
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

  describe('money moves only against a funded hold of its own (FU-163, FU-164, D-130)', () => {
    const scalar = async (sql: string, ...args: unknown[]) => {
      const [row] = await asRuntime((client) =>
        client.$queryRawUnsafe<{ answer: boolean }[]>(`SELECT ${sql} AS answer`, ...args),
      );
      return row!.answer;
    };
    const holdIdsOf = async (transactionId: string) =>
      (
        await owner.$queryRawUnsafe<{ id: string; placed_journal_id: string | null }[]>(
          `SELECT id, placed_journal_id FROM wallet_hold WHERE reference = $1 ORDER BY placed_at, id`,
          transactionId,
        )
      ).map((hold) => ({ id: hold.id, journalId: hold.placed_journal_id }));

    const account = async (organization: string, purpose: string, currency: string) => {
      const found = await owner.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM ledger_account WHERE organization_id = $1 AND purpose = $2::"AccountPurpose" AND currency = $3`,
        organization,
        purpose,
        currency,
      );
      if (found[0]) return found[0].id;
      const accountId = `ACC_${ulid()}`;
      await owner.$executeRawUnsafe(
        `INSERT INTO ledger_account (id, organization_id, account_type, account_code, purpose, currency, created_by)
         SELECT $1, $2, account_type, account_code, purpose, $3, 'USR-THD'
           FROM ledger_account WHERE organization_id = $4 AND purpose = $5::"AccountPurpose" LIMIT 1`,
        accountId,
        organization,
        currency,
        payer,
        purpose,
      );
      return accountId;
    };

    /** A journal as `placeHold` posts it, but for the one property a row changes. */
    const journalFor = async (
      transactionId: string,
      {
        type = 'FUNDS_HELD',
        books = payer,
        creditOrganization = payer,
        credit = 'ESCROW',
        debit = 'WALLET',
        amount = AMOUNT,
        currency = 'IRR',
      } = {},
    ) => {
      const journalId = `JRN_${ulid()}`;
      const [creditAccount, debitAccount] = [
        await account(creditOrganization, credit, currency),
        await account(payer, debit, currency),
      ];
      await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO journal (id, organization_id, transaction_id, journal_type, description, posted_at, posted_by, correlation_id)
           VALUES ($1, $2, $3, $4::"JournalType", 'planted by the suite', now(), 'USR-THD', 'thd')`,
          journalId,
          books,
          transactionId,
          type,
        );
        for (const [accountId, organization, direction] of [
          [creditAccount, creditOrganization, 'CREDIT'],
          [debitAccount, payer, 'DEBIT'],
        ] as const) {
          await tx.$executeRawUnsafe(
            `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
             VALUES ($1, $2, $3, $4, $5::"EntryDirection", $6, $7, now())`,
            `LGE_${ulid()}`,
            journalId,
            accountId,
            organization,
            direction,
            amount,
            currency,
          );
        }
      });
      return journalId;
    };

    const refund = (transactionId: string) =>
      request(http)
        .post(`/v1/transactions/${transactionId}/refund`)
        .set('authorization', asPayee())
        .set('idempotency-key', id('thd-fund-refund'))
        .send({ reason: 'The supplier returns the money.' });

    const refundedAsRuntime = (holdId: string, journalId: string) =>
      asRuntime((client) =>
        client.$executeRawUnsafe(
          `UPDATE wallet_hold SET status = 'REFUNDED', resolved_at = now(), resolved_by = 'USR-THD',
                  resolved_journal_id = $2 WHERE id = $1`,
          holdId,
          journalId,
        ),
      );

    it('control: the journal a row below changes one thing of is what funds a hold, and pays', async () => {
      const transactionId = await bare('HELD');
      await handHold(transactionId, AMOUNT, 'IRR', await journalFor(transactionId));
      const [hold] = await holdIdsOf(transactionId);
      expect(await scalar('wallet_hold_funded($1)', hold!.id)).toBe(true);
      expect(await provenEverywhere(transactionId)).toBe(true);
      expect(await barred(transactionId)).toBe(false);
      await authorise(transactionId);
      await settle(transactionId).expect(201);
    });

    it('a hold through the service is funded', async () => {
      const transactionId = await escrowed();
      const [hold] = await holdIdsOf(transactionId);
      expect(hold!.journalId).not.toBeNull();
      expect(await scalar('wallet_hold_funded($1)', hold!.id)).toBe(true);
      expect(await scalar(`wallet_hold_funded('HLD_NO_SUCH_HOLD')`)).toBe(false);
    });

    // Fail-first (D-130.1): each of these was proof, and paid.
    describe.each<[string, (row: string) => Promise<string | null>]>([
      ['no journal at all', async () => null],
      ['text no journal has', async () => `JRN_NO_SUCH_${ulid()}`],
      ['a journal of another kind', (row) => journalFor(row, { type: 'FUNDS_REFUNDED' })],
      ['another obligation’s funding', async () => journalFor(await bare('HELD'))],
      ['a journal on another organization’s books', (row) => journalFor(row, { books: payee })],
      [
        'a journal crediting something but escrow',
        (row) => journalFor(row, { credit: 'WALLET', debit: 'ESCROW' }),
      ],
      [
        'a journal crediting another organization’s escrow',
        (row) => journalFor(row, { creditOrganization: payee }),
      ],
      ['a journal for less', (row) => journalFor(row, { amount: AMOUNT - 1n })],
      ['a journal in another currency', (row) => journalFor(row, { currency: 'USD' })],
      [
        'a journal crediting and debiting its own escrow',
        (row) => journalFor(row, { credit: 'ESCROW', debit: 'ESCROW' }),
      ],
    ])('a hold for exactly its terms naming %s', (_case, journal) => {
      it.each(['on no list', 'HELD_UNPROVEN'])(
        '%s: proves nothing, and is not settled or refunded',
        async (listing) => {
          const transactionId = await bare('HELD');
          if (listing !== 'on no list') await listed(transactionId, listing);
          await handHold(transactionId, AMOUNT, 'IRR', await journal(transactionId));
          const [hold] = await holdIdsOf(transactionId);

          expect(await provenEverywhere(transactionId)).toBe(false);
          expect((await detail(transactionId, asPayee())).heldProven).toBe(false);
          expect(await scalar('transaction_own_hold_for_terms($1)', transactionId)).toBe(false);
          expect(await barred(transactionId)).toBe(true);
          expect(await scalar('wallet_hold_funded($1)', hold!.id)).toBe(false);
          if (listing !== 'on no list') {
            await expect(decide(transactionId, 'CONFIRMED')).rejects.toThrow(
              /confirmed only by its own active funded hold/,
            );
          }

          await authorise(transactionId);
          if (listing !== 'on no list') await decide(transactionId, 'VOIDED');
          const before = await money(transactionId);
          expect(before.status).toBe('PENDING_SETTLEMENT');
          const refused = await settle(transactionId);
          expect(refused.status).toBe(409);
          expect(refused.body.message).toContain('funded hold of its own');
          await expect(releaseAsRuntime(transactionId)).rejects.toThrow(RELEASE_REFUSED);
          await expect(settledAsRuntime(transactionId)).rejects.toThrow(PAYMENT_REFUSED);
          const refundRefused = await refund(transactionId);
          expect(refundRefused.status).toBeGreaterThanOrEqual(400);
          expect(refundRefused.body.message).toContain('nothing moves until an operator');
          expect(await money(transactionId)).toEqual(before);
        },
      );
    });

    it('still HELD, an unfunded hold does not refuse VOIDED: nothing is held, and it says so', async () => {
      const transactionId = await bare('HELD');
      await listed(transactionId, 'HELD_UNPROVEN');
      await handHold(transactionId);
      const before = await money(transactionId);
      const [answer] = await decide(transactionId, 'VOIDED');
      expect(answer!.status).toBe('HELD');
      expect(await money(transactionId)).toEqual(before);
      expect(await barred(transactionId)).toBe(true);
    });

    it('a retry trusts no unfunded hold', async () => {
      const reference = id('thd-unfunded-refund-hold');
      await owner.$executeRawUnsafe(
        `INSERT INTO wallet_hold (id, organization_id, wallet_id, amount_minor, currency, reference,
                                  reference_type, placed_at, placed_by)
         VALUES ($1, $2, $3, $4, 'IRR', $5, 'PAYMENT_REFUND', now(), 'USR-THD')`,
        `HLD_${ulid()}`,
        payer,
        walletId,
        AMOUNT,
        reference,
      );

      // As `PaymentService.refund` retries before it asks the provider: no answer to go on.
      const before = await asRuntime((client) =>
        client.journal.count({ where: { transactionId: reference } }),
      );
      await expect(
        runWithContext(
          createSystemContext({ correlationId: id('thd'), organizationId: payer }),
          () =>
            (harness.prisma.client as unknown as PrismaClient).$transaction(async (tx) => {
              const db = tx as unknown as ExtendedPrismaClient;
              const [wallet] = await harness.app.get(WalletRepository).lock(db, [walletId]);
              return harness.app.get(WalletService).placeHold(db, {
                wallet: wallet!,
                amountMinor: AMOUNT,
                reference,
                referenceType: 'PAYMENT_REFUND',
                transactionId: reference,
                placedBy: 'USR-THD',
              });
            }),
        ),
      ).rejects.toThrow(HOLD_NOT_FUNDED);
      expect(
        await asRuntime((client) => client.journal.count({ where: { transactionId: reference } })),
      ).toBe(before);
    });

    it('a funding journal reversed is no funding, and once a hold names it, it is not reversed', async () => {
      const reverse = async (tx: Tx, journalId: string) => {
        const reversal = `JRN_${ulid()}`;
        await tx.$executeRawUnsafe(
          `INSERT INTO journal (id, organization_id, transaction_id, journal_type, description, posted_at, posted_by,
                                correlation_id, reverses_id, reversal_reason)
           SELECT $1, organization_id, transaction_id, 'REVERSAL', 'reversed by the suite', now(), posted_by,
                  correlation_id, id, 'planted by the suite'
             FROM journal WHERE id = $2`,
          reversal,
          journalId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
           SELECT 'LGE_' || md5(id), $1, account_id, organization_id,
                  (CASE direction WHEN 'CREDIT' THEN 'DEBIT' ELSE 'CREDIT' END)::"EntryDirection",
                  amount_minor, currency, now()
             FROM ledger_entry WHERE journal_id = $2`,
          reversal,
          journalId,
        );
      };
      const transactionId = await bare('HELD');
      const journalId = await journalFor(transactionId);
      await handHold(transactionId, AMOUNT, 'IRR', journalId);
      const [hold] = await holdIdsOf(transactionId);
      expect(await scalar('wallet_hold_funded($1)', hold!.id)).toBe(true);
      // FU-182: the hold goes back by its refund.
      await expect(owner.$transaction((tx) => reverse(tx, journalId))).rejects.toThrow(
        /A journal a hold names is never reversed/,
      );
      expect(await scalar('wallet_hold_funded($1)', hold!.id)).toBe(true);

      // A row from before that guard: the journal reversed, then a hold naming it.
      const reversed = await bare('HELD');
      const reversedJournal = await journalFor(reversed);
      await owner.$transaction((tx) => reverse(tx, reversedJournal));
      await handHold(reversed, AMOUNT, 'IRR', reversedJournal);
      const [unfunded] = await holdIdsOf(reversed);
      expect(await scalar('wallet_hold_funded($1)', unfunded!.id)).toBe(false);
      expect(await barred(reversed)).toBe(true);
    });

    describe('where the database refuses it', () => {
      it.each(['TRANSACTION', 'PAYMENT_REFUND'])(
        'nothing resolves an unfunded %s hold, whoever writes it',
        async (purpose) => {
          const row = await bare('HELD');
          const reference = purpose === 'TRANSACTION' ? row : id('thd-refund-hold');
          const holdId = `HLD_${ulid()}`;
          await owner.$executeRawUnsafe(
            `INSERT INTO wallet_hold (id, organization_id, wallet_id, amount_minor, currency, reference,
                                      reference_type, placed_at, placed_by)
             VALUES ($1, $2, $3, $4, 'IRR', $5, $6, now(), 'USR-THD')`,
            holdId,
            payer,
            walletId,
            AMOUNT,
            reference,
            purpose,
          );
          const journalId = await journalFor(row, { type: 'FUNDS_REFUNDED' });
          await expect(refundedAsRuntime(holdId, journalId)).rejects.toThrow(
            /trg_wallet_hold_resolved_only_funded|never funded moves no money/,
          );
          await expect(
            owner.$executeRawUnsafe(
              `UPDATE wallet_hold SET status = 'RELEASED', resolved_at = now(), resolved_by = 'USR-THD',
                      resolved_journal_id = $2 WHERE id = $1`,
              holdId,
              journalId,
            ),
          ).rejects.toThrow(
            purpose === 'TRANSACTION' ? RELEASE_REFUSED : /never funded moves no money/,
          );
        },
      );

      it('control: a funded hold still refunds, escrow back to the payer', async () => {
        const transactionId = await escrowed();
        const before = await money(transactionId);
        await refund(transactionId).expect(200);
        const after = await money(transactionId);
        expect(after).toMatchObject({ status: 'REFUNDED', holds: ['REFUNDED'] });
        expect(after.spendable).toBe(before.spendable + AMOUNT);
      });

      it('a RELEASED hold no journal funded does not speak for a settlement', async () => {
        const transactionId = await bare('PENDING_SETTLEMENT');
        const settlementJournal = await journalFor(transactionId, { type: 'SETTLEMENT' });
        await expect(
          owner.$transaction(async (tx) => {
            // A row from before `trg_wallet_hold_inserted_only_funded`; the rollback restores it.
            // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this owner transaction.
            await tx.$executeRawUnsafe(
              'ALTER TABLE wallet_hold DISABLE TRIGGER trg_wallet_hold_inserted_only_funded',
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO wallet_hold (id, organization_id, wallet_id, amount_minor, currency, reference,
                                        reference_type, status, placed_at, placed_by, resolved_at,
                                        resolved_by, resolved_journal_id)
               VALUES ($1, $2, $3, $4, 'IRR', $5, 'TRANSACTION', 'RELEASED', now(), 'USR-THD', now(), 'USR-THD', $6)`,
              `HLD_${ulid()}`,
              payer,
              walletId,
              AMOUNT,
              transactionId,
              settlementJournal,
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO settlement (id, organization_id, transaction_id, journal_id, payer_organization_id,
                                       payee_organization_id, gross_amount_minor, commission_amount_minor,
                                       net_amount_minor, currency, settled_at, settled_by)
               VALUES ($1, $2, $3, $4, $2, $5, $6, 0, $6, 'IRR', now(), 'USR-THD')`,
              `STL_${ulid()}`,
              payer,
              transactionId,
              settlementJournal,
              payee,
              AMOUNT,
            );
            await tx.$executeRawUnsafe(
              `UPDATE "transaction" SET status = 'SETTLED', settled_at = now() WHERE id = $1`,
              transactionId,
            );
          }),
        ).rejects.toThrow(PAYMENT_REFUSED);
      });
    });

    describe('what has claimed escrow never pays from spendable', () => {
      // Fail-first (FU-164): this paid from the spendable balance.
      it('HELD on no list with no hold, authorised: refused at settlement, by service and database', async () => {
        const transactionId = await bare('HELD');
        await authorise(transactionId);
        expect((await detail(transactionId)).status).toBe('PENDING_SETTLEMENT');
        expect(await scalar('transaction_settlement_authorised($1, true)', transactionId)).toBe(
          true,
        );
        await expectPaysNothing(transactionId);
        expect(await barred(transactionId)).toBe(true);
      });

      it('nor the way round through a dispute: it resolves to HELD, and still pays nothing', async () => {
        const transactionId = await bare('HELD');
        await request(http)
          .post(`/v1/transactions/${transactionId}/dispute`)
          .set('authorization', asPayer())
          .set('idempotency-key', id('thd-164-dispute'))
          .send({ reason: 'The invoice names another supplier.' })
          .expect(200);
        await expect(
          asRuntime((client) =>
            client.$executeRawUnsafe(
              `UPDATE "transaction" SET status = 'PENDING_SETTLEMENT' WHERE id = $1`,
              transactionId,
            ),
          ),
        ).rejects.toThrow(/where its settlement authority stands/);
        const resolved = await request(http)
          .post(`/v1/transactions/${transactionId}/resolve-dispute`)
          .set('authorization', `Bearer ${admin(apiTenant('THD-PLATFORM'), ['SYSTEM_ADMIN'])}`)
          .set('idempotency-key', id('thd-164-resolve'))
          .send({ resolution: 'The objection is unfounded.' })
          .expect(200);
        expect(resolved.body).toMatchObject({ status: 'HELD', heldProven: false });
        await authorise(transactionId);
        await expectPaysNothing(transactionId);
      });

      it('a resolved hold of its own bars it too: what was returned is not paid from spendable', async () => {
        const transactionId = await bare('PENDING_SETTLEMENT');
        const refunded = await journalFor(transactionId, { type: 'FUNDS_REFUNDED' });
        // A row from before `trg_wallet_hold_inserted_only_funded`.
        await lifted('wallet_hold', BEFORE_FUNDED_GUARDS, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO wallet_hold (id, organization_id, wallet_id, amount_minor, currency, reference,
                                      reference_type, status, placed_at, placed_by, resolved_at,
                                      resolved_by, resolved_journal_id)
             VALUES ($1, $2, $3, $4, 'IRR', $5, 'TRANSACTION', 'REFUNDED', now(), 'USR-THD', now(), 'USR-THD', $6)`,
            `HLD_${ulid()}`,
            payer,
            walletId,
            AMOUNT,
            transactionId,
            refunded,
          ),
        );
        expect(await barred(transactionId)).toBe(true);
        await expectPaysNothing(transactionId);
      });

      it('having been HELD is stamped whoever wrote it, and no writer takes it back or forges it', async () => {
        const heldAt = async (transactionId: string) =>
          (
            await owner.$queryRawUnsafe<{ held_at: Date | null }[]>(
              'SELECT held_at FROM "transaction" WHERE id = $1',
              transactionId,
            )
          )[0]!.held_at;
        const transactionId = await bare('HELD');
        const stamped = await heldAt(transactionId);
        expect(stamped).not.toBeNull();

        const write = (sql: string, ...args: unknown[]) =>
          asRuntime((client) => client.$executeRawUnsafe(sql, ...args));
        await write(`UPDATE "transaction" SET held_at = NULL WHERE id = $1`, transactionId);
        await owner.$executeRawUnsafe(
          `UPDATE "transaction" SET held_at = NULL WHERE id = $1`,
          transactionId,
        );
        await write(
          `UPDATE "transaction" SET held_at = now() + interval '1 day', status = 'PENDING_SETTLEMENT' WHERE id = $1`,
          transactionId,
        );
        expect(await heldAt(transactionId)).toEqual(stamped);
        await expectPaysNothing(transactionId);

        // Nor can a column write bar a row that never claimed escrow.
        const never = await bare('PENDING_SETTLEMENT');
        await write(`UPDATE "transaction" SET held_at = now() WHERE id = $1`, never);
        expect(await heldAt(never)).toBeNull();
        await settle(never).expect(201);
      });

      it('control: CREATED, authorised with no hold, pays from spendable: it never claimed escrow', async () => {
        const transactionId = await bare('CREATED');
        await authorise(transactionId);
        const before = await money(transactionId);
        await settle(transactionId).expect(201);
        const after = await money(transactionId);
        expect(after.spendable).toBe(before.spendable - AMOUNT);
      });
    });

    describe('RESTORED_TO_PENDING_SETTLEMENT (D-130.2)', () => {
      // Fail-first: this debited the spendable balance.
      it('with nothing held debits nothing, authorised or not', async () => {
        const unauthorised = await bare('PENDING_SETTLEMENT');
        await listed(unauthorised, 'RESTORED_TO_PENDING_SETTLEMENT');
        await expectPaysNothing(unauthorised);
        expect(await barred(unauthorised)).toBe(true);

        const authorisedRow = await bare('PENDING_SETTLEMENT');
        await listed(authorisedRow, 'RESTORED_TO_PENDING_SETTLEMENT');
        await recordedAuthorised(authorisedRow);
        await expectPaysNothing(authorisedRow);
      });

      it('is still no decision an operator takes, and a refund ends it with no money moved', async () => {
        const transactionId = await bare('PENDING_SETTLEMENT');
        await listed(transactionId, 'RESTORED_TO_PENDING_SETTLEMENT');
        await expect(decide(transactionId, 'VOIDED')).rejects.toThrow(
          /no unresolved hold decision/,
        );
        const before = await money(transactionId);
        await refund(transactionId).expect(200);
        expect(await money(transactionId)).toMatchObject({
          status: 'REFUNDED',
          journals: before.journals,
          spendable: before.spendable,
        });
      });

      it('disputed, it resolves to HELD, and the database agrees', async () => {
        const transactionId = await bare('PENDING_SETTLEMENT');
        await listed(transactionId, 'RESTORED_TO_PENDING_SETTLEMENT');
        await request(http)
          .post(`/v1/transactions/${transactionId}/dispute`)
          .set('authorization', asPayer())
          .set('idempotency-key', id('thd-restored-dispute'))
          .send({ reason: 'The invoice names another supplier.' })
          .expect(200);
        const resolved = await request(http)
          .post(`/v1/transactions/${transactionId}/resolve-dispute`)
          .set('authorization', `Bearer ${admin(apiTenant('THD-PLATFORM'), ['SYSTEM_ADMIN'])}`)
          .set('idempotency-key', id('thd-restored-resolve'))
          .send({ resolution: 'The objection is unfounded.' })
          .expect(200);
        expect(resolved.body.status).toBe('HELD');
      });
    });

    describe('a statement’s obligation on the list (D-130.4)', () => {
      const statementObligation = async () => {
        const reference = id('thd-statement');
        const { id: transactionId } = await runWithContext(
          createSystemContext({ correlationId: id('thd'), organizationId: payer }),
          () =>
            (harness.prisma.client as unknown as PrismaClient).$transaction((tx) =>
              harness.app
                .get(TransactionService)
                .recordAuthorisedObligation(tx as unknown as ExtendedPrismaClient, {
                  organizationId: payer,
                  counterpartyOrganizationId: payee,
                  transactionType: 'CONSTRUCTION_STATEMENT',
                  businessLine: null,
                  grossAmountMinor: AMOUNT,
                  currency: 'IRR',
                  occurredAt: new Date(),
                  sourceType: 'STATEMENT',
                  sourceReference: reference,
                  causationId: reference,
                }),
            ),
        );
        planted.push(transactionId);
        return transactionId;
      };

      it.each(['VOIDED', 'CONFIRMED'])(
        '%s: blocked with nothing moved, and the operator is told what blocks it',
        async (decision) => {
          const transactionId = await statementObligation();
          await listed(transactionId, 'DISPUTE_RESOLVED_UNPROVEN');
          await decide(transactionId, decision);
          const before = await money(transactionId);

          const refused = await settle(transactionId);
          expect(refused.status).toBe(409);
          expect(refused.body.code).toBe('INVALID_STATE_TRANSITION');
          expect(refused.body.message).toContain('until the product owner decides');
          await expect(settledAsRuntime(transactionId)).rejects.toThrow(PAYMENT_REFUSED);

          const withdrawn = await refund(transactionId);
          expect(withdrawn.status).toBeGreaterThanOrEqual(400);
          expect(withdrawn.body.message).toContain('not refunded or cancelled');
          expect(await money(transactionId)).toEqual(before);
        },
      );

      it('RESTORED: the same, since a restored row pays only from a hold (D-130.2)', async () => {
        const transactionId = await statementObligation();
        await listed(transactionId, 'RESTORED_TO_PENDING_SETTLEMENT');
        const refused = await settle(transactionId);
        expect(refused.status).toBe(409);
        expect(refused.body.message).toContain('until the product owner decides');
      });

      it('control: one on no list still pays from spendable', async () => {
        const transactionId = await statementObligation();
        expect(await barred(transactionId)).toBe(false);
      });
    });
  });
});
