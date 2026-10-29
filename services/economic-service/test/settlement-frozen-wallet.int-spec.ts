import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * A settlement debits the payer's wallet only while it is ACTIVE, unless the
 * money is already in escrow (economic audit F2).
 *
 * `WalletStatus.FROZEN` reads "no new debits or holds … existing holds still
 * resolve" (schema.prisma). Placing a hold, a top-up and a payment refund
 * all refused a wallet that was not ACTIVE; a settlement with no hold behind
 * it — the maintenance obligation of ADR-032 — checked only the balance, and
 * debited a frozen wallet. These cases are the matrix the fix answers:
 *
 *   payer ACTIVE, no hold    → settles (the control)
 *   payer FROZEN, no hold    → 422, and nothing financial written — not even
 *                              the payee wallet the settlement had opened
 *   payer CLOSED, no hold    → 422, the same
 *   payer FROZEN, held       → settles: the escrow resolves, as the schema says
 *   payee FROZEN             → settles: a freeze stops money leaving a wallet,
 *                              not arriving in it, and the schema gates debits
 *                              and holds only
 */
describe('settlement against a wallet that is not ACTIVE', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('FRZ-PAYER');
  const payees: string[] = [];
  const asPayer = () => `Bearer ${admin(payer)}`;

  async function walletOf(organizationId: string) {
    return runUnscoped('the suite reads the wallets it asserts on', () =>
      harness.prisma.client.wallet.findFirst({
        where: { organizationId, currency: 'IRR' },
        select: {
          id: true,
          status: true,
          ledgerBalanceMinor: true,
          pendingBalanceMinor: true,
          availableBalanceMinor: true,
        },
      }),
    );
  }

  async function setStatus(organizationId: string, status: 'ACTIVE' | 'FROZEN' | 'CLOSED') {
    await runUnscoped('the suite freezes a wallet as an operator would', () =>
      harness.prisma.client.wallet.updateMany({
        where: { organizationId, currency: 'IRR' },
        data: { status },
      }),
    );
  }

  /** A payee no request has touched: its wallet is opened by the settlement, if at all. */
  function newPayee(label: string): string {
    const organizationId = apiTenant(`FRZ-${label}`);
    payees.push(organizationId);
    return organizationId;
  }

  /** An obligation authorised for settlement, with or without its funds held. */
  async function pendingSettlement(payee: string, holdFunds: boolean): Promise<string> {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', id('frz-txn'))
      .send({
        transactionType: 'MAINTENANCE_SERVICE',
        businessLine: 'MAINTENANCE',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '40000',
        currency: 'IRR',
        holdFunds,
      })
      .expect(201);
    await request(http)
      .post(`/v1/transactions/${created.body.id}/authorise-settlement`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('frz-authorise'))
      .expect(200);
    return created.body.id as string;
  }

  const settle = (transactionId: string, key = id('frz-settle')) =>
    request(http)
      .post('/v1/settlements')
      .set('authorization', asPayer())
      .set('idempotency-key', key)
      .send({ transactionId });

  /**
   * Every financial table, counted, with the payer's figures and the
   * transaction's status: what a refusal must leave exactly as it was.
   */
  async function financialState(transactionId: string, payee: string) {
    return runUnscoped('the suite snapshots the financial tables', async () => {
      const client = harness.prisma.client;
      const wallet = await walletOf(payer);
      const transaction = await client.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        select: { status: true },
      });
      return {
        journals: await client.journal.count(),
        entries: await client.ledgerEntry.count(),
        accounts: await client.ledgerAccount.count(),
        wallets: await client.wallet.count(),
        holds: await client.walletHold.count(),
        settlements: await client.settlement.count(),
        commissions: await client.commission.count(),
        payeeWallet: await client.wallet.count({ where: { organizationId: payee } }),
        payeeAccounts: await client.ledgerAccount.count({ where: { organizationId: payee } }),
        events: await client.outboxMessage.count({ where: { aggregateId: transactionId } }),
        transactionStatus: transaction.status,
        payer: {
          status: wallet?.status,
          ledger: wallet?.ledgerBalanceMinor.toString(),
          pending: wallet?.pendingBalanceMinor.toString(),
          available: wallet?.availableBalanceMinor.toString(),
        },
      };
    });
  }

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', asPayer())
      .expect(200);
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('frz-fund'))
      .send({ amountMinor: '10000000' })
      .expect(201);
  });

  afterEach(async () => {
    await setStatus(payer, 'ACTIVE');
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, ...payees]);
    await harness.close();
  });

  it('settles from an ACTIVE wallet with no hold (the control)', async () => {
    const transactionId = await pendingSettlement(newPayee('ACTIVE'), false);
    const settled = await settle(transactionId).expect(201);
    expect(settled.body.grossAmountMinor).toBe('40000');
  });

  it.each(['FROZEN', 'CLOSED'] as const)(
    'refuses a %s payer with no hold, and writes nothing financial — not even the payee wallet',
    async (status) => {
      const payee = newPayee(status);
      const transactionId = await pendingSettlement(payee, false);
      await setStatus(payer, status);
      const before = await financialState(transactionId, payee);
      // The payee has never been paid: the settlement would open its wallet.
      expect(before.payeeWallet).toBe(0);

      const key = id('frz-refused');
      const refused = await settle(transactionId, key).expect(422);

      expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(refused.body.message).toBe(
        'The paying wallet is not active; a settlement with no funds held cannot debit it',
      );
      expect(await financialState(transactionId, payee)).toEqual(before);

      // The refusal freed its key: once the wallet is active again, the same
      // request settles, and the payee wallet is opened then.
      await setStatus(payer, 'ACTIVE');
      await settle(transactionId, key).expect(201);
      const after = await financialState(transactionId, payee);
      expect(after.transactionStatus).toBe('SETTLED');
      expect(after.payeeWallet).toBe(1);
    },
  );

  it('settles a FROZEN payer’s existing hold: escrow resolves, the wallet is not debited', async () => {
    const transactionId = await pendingSettlement(newPayee('HELD'), true);
    const held = await walletOf(payer);
    await setStatus(payer, 'FROZEN');

    const settled = await settle(transactionId).expect(201);
    expect(settled.body.grossAmountMinor).toBe('40000');

    const after = await walletOf(payer);
    expect(after?.status).toBe('FROZEN');
    // The held amount leaves escrow; the spendable balance does not move.
    expect(after?.availableBalanceMinor.toString()).toBe(held?.availableBalanceMinor.toString());
    expect((held!.pendingBalanceMinor - after!.pendingBalanceMinor).toString()).toBe('40000');

    const journal = await request(http)
      .get(`/v1/ledger/journals/${settled.body.journalId}`)
      .set('authorization', asPayer())
      .expect(200);
    const debits = (journal.body.entries as { direction: string; accountId: string }[]).filter(
      (entry) => entry.direction === 'DEBIT',
    );
    const accounts = await runUnscoped('the suite names the debited accounts', () =>
      harness.prisma.client.ledgerAccount.findMany({
        where: { id: { in: debits.map((entry) => entry.accountId) } },
        select: { purpose: true },
      }),
    );
    expect(accounts.map((account) => account.purpose)).toEqual(['ESCROW']);
  });

  it('credits a FROZEN payee: a freeze gates debits and holds, not money arriving', async () => {
    const payee = newPayee('PAYEE');
    await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(payee)}`)
      .expect(200);
    const transactionId = await pendingSettlement(payee, false);
    await setStatus(payee, 'FROZEN');

    const settled = await settle(transactionId).expect(201);

    const credited = await walletOf(payee);
    expect(credited?.status).toBe('FROZEN');
    expect(credited?.ledgerBalanceMinor.toString()).toBe(settled.body.netAmountMinor);
  });
});
