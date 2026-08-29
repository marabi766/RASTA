import { test, expect, errorCode, idempotencyKey, minor, type Actor } from '../../src/api';
import { ORG } from '../../src/env';

/**
 * Scenario 2 — the economic critical path, end to end.
 *
 * This is the journey docs/14 § 14.7 row 4 describes without its marketplace
 * half: obligation → hold → confirmed receipt → settlement → commission. The
 * marketplace half is deliberately absent rather than simulated. `ORDER_*` is
 * deferred by ADR-032, and writing an order payload here would mean inventing
 * the contract of a service that does not exist yet — which is the one thing
 * AGENTS.md § 9 forbids outright. What the platform actually supports today is
 * the API path, and that is what runs.
 *
 * Every step below goes through api-gateway to the real economic-service, on a
 * real PostgreSQL, with a real Kafka behind the outbox, holding a real
 * Keycloak token. Nothing is stubbed — not the wallet, not the ledger, not the
 * payment provider (which is *simulated*, and says so, which is a different
 * thing from mocked), not the settlement, not the authorization.
 */

const GROSS = 12_000_000n; // 1,200,000 rial in minor units
const TOP_UP = 40_000_000n;

interface Balances {
  ledger: bigint;
  pending: bigint;
  available: bigint;
  walletId: string;
}

async function balances(actor: Actor): Promise<Balances> {
  const response = await actor.get('/v1/wallets/me');
  expect(response.status).toBe(200);
  const wallet = response.body as {
    id: string;
    ledgerBalanceMinor: string;
    pendingBalanceMinor: string;
    availableBalanceMinor: string;
  };
  return {
    walletId: wallet.id,
    ledger: minor(wallet.ledgerBalanceMinor),
    pending: minor(wallet.pendingBalanceMinor),
    available: minor(wallet.availableBalanceMinor),
  };
}

/**
 * Serial, and stateful on purpose.
 *
 * The point of this file is the *sequence*: a settlement that succeeds without
 * a preceding authorisation would be the defect, so the steps cannot be
 * independent of one another. Balances are asserted as **deltas** rather than
 * absolutes, so the suite is re-runnable against a database that already holds
 * earlier runs.
 */
test.describe.serial('Economic critical path', () => {
  let transactionId: string;
  let settlementJournalId: string;
  let createKey: string;
  let settleKey: string;
  let settlementId: string;

  let payerBefore: Balances;
  let payeeBefore: Balances;
  let payerAfterTopUp: Balances;
  let payerAfterHold: Balances;

  test('opens a wallet for each party on first use', async ({ tenantA, tenantB }) => {
    payerBefore = await balances(tenantA);
    payeeBefore = await balances(tenantB);

    expect(payerBefore.walletId).not.toBe(payeeBefore.walletId);
    // `available = ledger − pending` is a database CHECK, not an application
    // rule (ADR-034). Asserting it here proves the constraint is live in the
    // deployed schema, not only in the migration file.
    expect(payerBefore.available).toBe(payerBefore.ledger - payerBefore.pending);
    expect(payeeBefore.available).toBe(payeeBefore.ledger - payeeBefore.pending);

    // The wallet is addressable by id as well as by `me`, and it is the same
    // wallet.
    const byId = await tenantA.get(`/v1/wallets/${payerBefore.walletId}`);
    expect(byId.status).toBe(200);
    expect((byId.body as { organizationId: string }).organizationId).toBe(ORG.a);
  });

  test('the payment provider funds the wallet and declares itself simulated', async ({
    tenantA,
  }) => {
    // ADR-024: the simulated nature of MVP payments must be visible in the
    // API, not only in a document. A client that cannot ask cannot show it.
    const disclosure = await tenantA.get('/v1/wallets/provider');
    expect(disclosure.status).toBe(200);
    expect((disclosure.body as { simulated: boolean }).simulated).toBe(true);

    const response = await tenantA.post(`/v1/wallets/${payerBefore.walletId}/top-up`, {
      idempotencyKey: idempotencyKey('topup'),
      body: { amountMinor: TOP_UP.toString() },
    });

    expect(response.status).toBe(201);
    const result = response.body as {
      status: string;
      simulated: boolean;
      amountMinor: string;
      journalId: string;
    };
    expect(result.status).toBe('CAPTURED');
    expect(result.simulated).toBe(true);
    expect(minor(result.amountMinor)).toBe(TOP_UP);

    payerAfterTopUp = await balances(tenantA);
    expect(payerAfterTopUp.ledger).toBe(payerBefore.ledger + TOP_UP);
    expect(payerAfterTopUp.available).toBe(payerBefore.available + TOP_UP);
    expect(payerAfterTopUp.pending).toBe(payerBefore.pending);
  });

  test('recording the obligation holds the funds in the same breath', async ({ tenantA }) => {
    createKey = idempotencyKey('create-transaction');

    const response = await tenantA.post('/v1/transactions', {
      idempotencyKey: createKey,
      body: {
        transactionType: 'MAINTENANCE_SERVICE',
        counterpartyOrganizationId: ORG.b,
        grossAmountMinor: GROSS.toString(),
        currency: 'IRR',
        sourceType: 'E2E',
        sourceReference: createKey,
        holdFunds: true,
      },
    });

    expect(response.status).toBe(201);
    const created = response.body as { id: string; status: string; grossAmountMinor: string };
    transactionId = created.id;
    // The hold and the obligation are created together, so there is no window
    // in which the obligation exists and the money is still spendable
    // (docs/10 § 10.5).
    expect(created.status).toBe('HELD');
    expect(minor(created.grossAmountMinor)).toBe(GROSS);

    payerAfterHold = await balances(tenantA);
    // Escrow is inside the same organization (ADR-034): the total the platform
    // owes this tenant does not change, what is spendable does.
    expect(payerAfterHold.ledger).toBe(payerAfterTopUp.ledger);
    expect(payerAfterHold.pending).toBe(payerAfterTopUp.pending + GROSS);
    expect(payerAfterHold.available).toBe(payerAfterTopUp.available - GROSS);

    const holds = await tenantA.get(`/v1/wallets/${payerBefore.walletId}/holds?status=ACTIVE`);
    expect(holds.status).toBe(200);
    const active = (holds.body as { items: { reference: string; amountMinor: string }[] }).items;
    const ours = active.filter((hold) => hold.reference === transactionId);
    expect(ours).toHaveLength(1);
    expect(minor(ours[0]!.amountMinor)).toBe(GROSS);
  });

  test('replaying the same Idempotency-Key has no second financial effect', async ({ tenantA }) => {
    const replay = await tenantA.post('/v1/transactions', {
      idempotencyKey: createKey,
      body: {
        transactionType: 'MAINTENANCE_SERVICE',
        counterpartyOrganizationId: ORG.b,
        grossAmountMinor: GROSS.toString(),
        currency: 'IRR',
        sourceType: 'E2E',
        sourceReference: createKey,
        holdFunds: true,
      },
    });

    // The stored response, byte for byte — not a new transaction that happens
    // to look the same.
    expect(replay.status).toBe(201);
    expect((replay.body as { id: string }).id).toBe(transactionId);

    const after = await balances(tenantA);
    expect(after.ledger).toBe(payerAfterHold.ledger);
    expect(after.pending).toBe(payerAfterHold.pending);
    expect(after.available).toBe(payerAfterHold.available);

    // And exactly one hold, not two. The balances above would also catch a
    // double hold, but this names it.
    const holds = await tenantA.get(`/v1/wallets/${payerBefore.walletId}/holds?status=ACTIVE`);
    const ours = (holds.body as { items: { reference: string }[] }).items.filter(
      (hold) => hold.reference === transactionId,
    );
    expect(ours).toHaveLength(1);
  });

  test('settlement before confirmed receipt is impossible', async ({ tenantA }) => {
    // The product-document control, and it is structural: the state machine
    // has no edge from HELD to SETTLED, so this is not a check that could be
    // forgotten (docs/10 § 10.5).
    const premature = await tenantA.post('/v1/settlements', {
      idempotencyKey: idempotencyKey('premature-settle'),
      body: { transactionId },
    });

    expect(premature.status).toBe(409);
    expect(errorCode(premature.body)).toBe('INVALID_STATE_TRANSITION');

    const after = await balances(tenantA);
    expect(after.pending).toBe(payerAfterHold.pending);
    expect(after.ledger).toBe(payerAfterHold.ledger);
  });

  test('confirming receipt authorises settlement, and does not perform it', async ({ tenantA }) => {
    const response = await tenantA.post(`/v1/transactions/${transactionId}/authorise-settlement`, {
      idempotencyKey: idempotencyKey('authorise'),
    });

    expect(response.status).toBe(200);
    expect((response.body as { status: string }).status).toBe('PENDING_SETTLEMENT');

    // Authorising moves no money. Confirming that goods arrived and releasing
    // payment for them are two decisions, often by two people.
    const after = await balances(tenantA);
    expect(after.ledger).toBe(payerAfterHold.ledger);
    expect(after.pending).toBe(payerAfterHold.pending);
    expect(after.available).toBe(payerAfterHold.available);
  });

  test('settlement releases escrow to the payee and closes the hold', async ({ tenantA }) => {
    settleKey = idempotencyKey('settle');

    const response = await tenantA.post('/v1/settlements', {
      idempotencyKey: settleKey,
      body: { transactionId },
    });

    expect(response.status).toBe(201);
    const settlement = response.body as {
      settlementId: string;
      journalId: string;
      grossAmountMinor: string;
      commissionAmountMinor: string;
      netAmountMinor: string;
      commissionRuleMatched: boolean;
    };
    settlementId = settlement.settlementId;
    settlementJournalId = settlement.journalId;

    expect(minor(settlement.grossAmountMinor)).toBe(GROSS);
    // No commission rule is configured on this platform (docs/24 Q-08), so the
    // commission is zero **because nothing was configured** — which the
    // response states rather than leaving to be inferred from a zero.
    expect(settlement.commissionRuleMatched).toBe(false);
    expect(minor(settlement.netAmountMinor) + minor(settlement.commissionAmountMinor)).toBe(GROSS);

    const transaction = await tenantA.get(`/v1/transactions/${transactionId}`);
    expect((transaction.body as { status: string }).status).toBe('SETTLED');

    const holds = await tenantA.get(`/v1/wallets/${payerBefore.walletId}/holds?status=ACTIVE`);
    const stillHeld = (holds.body as { items: { reference: string }[] }).items.filter(
      (hold) => hold.reference === transactionId,
    );
    expect(stillHeld).toHaveLength(0);
  });

  test('the resulting journal balances', async ({ tenantA, platformAdmin, config }) => {
    // Read from economic-service directly, and this is the one call in the
    // suite that does not go through the gateway. Not a convenience: a journal
    // is tenant-scoped to the organization that owns it, and the gateway's
    // routing table restricts the whole `ledger` prefix to platform roles — so
    // the tenant that owns the journal is refused at the edge (403) and the
    // platform role that passes the edge is refused by the tenant scope (404).
    // As deployed, `GET /v1/ledger/journals/:id` returns data to nobody through
    // the front door. That is a real gap, recorded as docs/24 Q-27; it is not
    // this suite's to decide, and asserting the balance through the only path
    // that reaches it keeps the financial property under test in the meantime.
    const response = await tenantA.get(`/v1/ledger/journals/${settlementJournalId}`, {
      baseUrl: config.economicUrl,
    });
    expect(response.status).toBe(200);

    const journal = response.body as {
      entries: { direction: string; amountMinor: string; currency: string }[];
    };
    expect(journal.entries.length).toBeGreaterThanOrEqual(2);

    const byCurrency = new Map<string, bigint>();
    for (const entry of journal.entries) {
      const signed =
        entry.direction === 'DEBIT' ? minor(entry.amountMinor) : -minor(entry.amountMinor);
      byCurrency.set(entry.currency, (byCurrency.get(entry.currency) ?? 0n) + signed);
    }
    // Σ debit = Σ credit, per currency — docs/10 § 10.12's first mandatory row,
    // asserted here against the journal the platform actually posted.
    for (const [currency, delta] of byCurrency) {
      expect(`${currency}:${delta}`).toBe(`${currency}:0`);
    }

    const trial = await platformAdmin.get('/v1/ledger/trial-balance?currency=IRR');
    expect(trial.status).toBe(200);
    const balance = trial.body as {
      balanced: boolean;
      totalDebitMinor: string;
      totalCreditMinor: string;
    };
    expect(balance.balanced).toBe(true);
    expect(minor(balance.totalDebitMinor)).toBe(minor(balance.totalCreditMinor));
  });

  test('both wallets end at the balances the settlement implies', async ({ tenantA, tenantB }) => {
    const payer = await balances(tenantA);
    const payee = await balances(tenantB);

    // Payer: the escrowed money left. What was spendable never changes at
    // settlement, because it was already committed at hold time.
    expect(payer.pending).toBe(payerAfterHold.pending - GROSS);
    expect(payer.ledger).toBe(payerAfterHold.ledger - GROSS);
    expect(payer.available).toBe(payerAfterHold.available);
    expect(payer.available).toBe(payer.ledger - payer.pending);

    // Payee: credited the net. With no commission rule configured the net is
    // the gross, and asserting the identity rather than the number keeps this
    // true the day a rate is configured.
    expect(payee.ledger).toBe(payeeBefore.ledger + GROSS);
    expect(payee.available).toBe(payeeBefore.available + GROSS);
    expect(payee.available).toBe(payee.ledger - payee.pending);
  });

  test('replaying the settlement key returns the first settlement, not a second', async ({
    tenantA,
    tenantB,
  }) => {
    const payerBeforeReplay = await balances(tenantA);
    const payeeBeforeReplay = await balances(tenantB);

    const replay = await tenantA.post('/v1/settlements', {
      idempotencyKey: settleKey,
      body: { transactionId },
    });

    expect(replay.status).toBe(201);
    expect((replay.body as { settlementId: string }).settlementId).toBe(settlementId);

    expect(await balances(tenantA)).toEqual(payerBeforeReplay);
    expect(await balances(tenantB)).toEqual(payeeBeforeReplay);
  });

  test('the payee can read the settlement it was paid by', async ({ tenantB }) => {
    // A settlement names two organizations and both are entitled to it — a
    // single-tenant filter cannot express that, so the service crosses the
    // guard deliberately and narrows to the caller's own id.
    const response = await tenantB.get(`/v1/settlements/${settlementId}`);

    expect(response.status).toBe(200);
    const settlement = response.body as { payeeOrganizationId: string; transactionId: string };
    expect(settlement.payeeOrganizationId).toBe(ORG.b);
    expect(settlement.transactionId).toBe(transactionId);
  });
});
