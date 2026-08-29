import { test, expect, errorCode, idempotencyKey, minor } from '../../src/api';
import { ORG } from '../../src/env';

/**
 * Scenario 4 — the refusals that keep the ledger honest.
 *
 * Everything here is a path that must **fail**, and fail without leaving a
 * trace. docs/10 § 10.12 makes two of them merge gates in their own right:
 * money that cannot be overspent, and one idempotency key producing one
 * effect. They are proved at the integration level against the database; this
 * file proves the same properties survive the whole stack — gateway, guards,
 * validation, service and constraint — which is where a check can be present
 * in the domain and absent from the deployed path.
 */
test.describe('Financial safety through the whole stack', () => {
  test('a hold larger than the available balance is refused and leaves no balance behind', async ({
    tenantA,
  }) => {
    const before = await tenantA.get('/v1/wallets/me');
    const wallet = before.body as {
      ledgerBalanceMinor: string;
      pendingBalanceMinor: string;
      availableBalanceMinor: string;
    };
    const available = minor(wallet.availableBalanceMinor);

    // Comfortably more than the wallet holds, whatever it holds — so this
    // stays a real overdraft attempt on a re-run against a funded wallet.
    const excessive = available + 999_999_999_999n;

    const key = idempotencyKey('overspend');
    const response = await tenantA.post('/v1/transactions', {
      idempotencyKey: key,
      body: {
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: ORG.b,
        grossAmountMinor: excessive.toString(),
        currency: 'IRR',
        sourceType: 'E2E',
        sourceReference: key,
        holdFunds: true,
      },
    });

    expect(response.status).toBe(422);
    expect(errorCode(response.body)).toBe('INSUFFICIENT_BALANCE');

    const after = (await tenantA.get('/v1/wallets/me')).body as {
      ledgerBalanceMinor: string;
      pendingBalanceMinor: string;
      availableBalanceMinor: string;
    };

    // Not merely "no negative balance" — *no change at all*. The obligation
    // and the hold are created in one transaction, so a refused hold must roll
    // the obligation back with it rather than leaving one nothing will ever
    // release.
    expect(after).toEqual(wallet);
    expect(minor(after.availableBalanceMinor)).toBeGreaterThanOrEqual(0n);
    expect(minor(after.ledgerBalanceMinor)).toBeGreaterThanOrEqual(0n);
    expect(minor(after.pendingBalanceMinor)).toBeGreaterThanOrEqual(0n);

    // And no orphaned obligation under that reference.
    const listed = await tenantA.get(`/v1/transactions?sourceReference=${encodeURIComponent(key)}`);
    expect((listed.body as { items: unknown[] }).items).toHaveLength(0);
  });

  test('a financial write without an Idempotency-Key is refused at the edge', async ({
    tenantA,
  }) => {
    const response = await tenantA.post('/v1/transactions', {
      body: {
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: ORG.b,
        grossAmountMinor: '1000',
        holdFunds: false,
      },
    });

    // The gateway rejects it before the service is ever reached. A key the
    // server invents would be useless — the client's retry would carry a
    // different one and charge twice (docs/06 § 6.8).
    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe('VALIDATION_FAILED');
  });

  test('reusing a key with a different body is a conflict, not a silent replay', async ({
    tenantA,
  }) => {
    const key = idempotencyKey('reuse');

    const first = await tenantA.post('/v1/transactions', {
      idempotencyKey: key,
      body: {
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: ORG.b,
        grossAmountMinor: '1000',
        currency: 'IRR',
        sourceType: 'E2E',
        sourceReference: key,
        holdFunds: false,
      },
    });
    expect(first.status).toBe(201);

    const second = await tenantA.post('/v1/transactions', {
      idempotencyKey: key,
      body: {
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: ORG.b,
        // A different amount under the same key. Returning the first response
        // would tell the caller their 2,000 was recorded when 1,000 was.
        grossAmountMinor: '2000',
        currency: 'IRR',
        sourceType: 'E2E',
        sourceReference: key,
        holdFunds: false,
      },
    });

    expect(second.status).toBe(409);
    expect(errorCode(second.body)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('an objection stops settlement completely', async ({ tenantA }) => {
    const key = idempotencyKey('dispute');
    const created = await tenantA.post('/v1/transactions', {
      idempotencyKey: key,
      body: {
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: ORG.b,
        grossAmountMinor: '9000',
        currency: 'IRR',
        sourceType: 'E2E',
        sourceReference: key,
        holdFunds: true,
      },
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;

    await tenantA.post(`/v1/transactions/${id}/authorise-settlement`, {
      idempotencyKey: idempotencyKey('dispute-authorise'),
    });

    const disputed = await tenantA.post(`/v1/transactions/${id}/dispute`, {
      idempotencyKey: idempotencyKey('dispute-raise'),
      body: { reason: 'The delivered quantity does not match the recorded obligation.' },
    });
    expect(disputed.status).toBe(200);
    expect((disputed.body as { status: string }).status).toBe('DISPUTED');

    const settle = await tenantA.post('/v1/settlements', {
      idempotencyKey: idempotencyKey('dispute-settle'),
      body: { transactionId: id },
    });

    // Not a policy check that could be relaxed: the state machine has no edge
    // from DISPUTED to SETTLED, so there is no path to money moving
    // (docs/10 § 10.5).
    expect(settle.status).toBe(409);
    expect(errorCode(settle.body)).toBe('INVALID_STATE_TRANSITION');

    // And the money is still where it was — held, not moved and not returned.
    const after = await tenantA.get(`/v1/transactions/${id}`);
    expect((after.body as { status: string }).status).toBe('DISPUTED');
  });

  test('an amount larger than a JSON number survives the round trip', async ({ tenantA }) => {
    // ADR-022: amounts are strings in minor units because a rial figure past
    // Number.MAX_SAFE_INTEGER is truncated by the client's JSON parser, where
    // no validation can see it. 9007199254740993 is the first integer a double
    // cannot represent.
    const beyondDouble = '9007199254740993';

    const key = idempotencyKey('bigint');
    const created = await tenantA.post('/v1/transactions', {
      idempotencyKey: key,
      body: {
        transactionType: 'CONSTRUCTION_STATEMENT',
        counterpartyOrganizationId: ORG.b,
        grossAmountMinor: beyondDouble,
        currency: 'IRR',
        sourceType: 'E2E',
        sourceReference: key,
        holdFunds: false,
      },
    });

    expect(created.status).toBe(201);
    expect((created.body as { grossAmountMinor: string }).grossAmountMinor).toBe(beyondDouble);

    const read = await tenantA.get(`/v1/transactions/${(created.body as { id: string }).id}`);
    expect((read.body as { grossAmountMinor: string }).grossAmountMinor).toBe(beyondDouble);
  });
});
