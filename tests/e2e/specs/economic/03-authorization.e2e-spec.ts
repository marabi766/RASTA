import { test, expect, errorCode, idempotencyKey } from '../../src/api';
import { ORG } from '../../src/env';

/**
 * Scenario 3 — object-level authorization across the whole economic surface.
 *
 * docs/14 § 14.7 row 8 ("کاربر A داده B را نمی‌بیند") and the mandatory
 * authorization matrix of docs/14 § 14.6. Two rules are proved here, and both
 * are absolute:
 *
 *  1. **Cross-tenant reads answer 404, never 403.** A 403 confirms the record
 *     exists, and an attacker walking identifiers could then map which
 *     organizations trade with which and for how much (docs/09).
 *
 *  2. **`AUDITOR` reaches nothing in this service.** The product document
 *     gives province oversight aggregate access only; the governance dashboard
 *     is served by analytics-service. The rule is enforced at the gateway, in
 *     every controller's `@Roles`, and again in `access.ts` — and this suite
 *     asks the running platform rather than trusting any one of them.
 */
test.describe('Economic authorization', () => {
  let walletId: string;
  let transactionId: string;

  test.beforeAll(async ({ tenantA }) => {
    const wallet = await tenantA.get('/v1/wallets/me');
    walletId = (wallet.body as { id: string }).id;

    const key = idempotencyKey('authz-transaction');
    const created = await tenantA.post('/v1/transactions', {
      idempotencyKey: key,
      body: {
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: ORG.b,
        grossAmountMinor: '5000',
        currency: 'IRR',
        sourceType: 'E2E',
        sourceReference: key,
        // No hold: this fixture exists to be *read* across a tenant boundary,
        // and it should not depend on the payer's balance.
        holdFunds: false,
      },
    });
    expect(created.status).toBe(201);
    transactionId = (created.body as { id: string }).id;
  });

  test("another tenant's wallet is not found, not forbidden", async ({ tenantB }) => {
    const response = await tenantB.get(`/v1/wallets/${walletId}`);

    expect(response.status).toBe(404);
    expect(errorCode(response.body)).toBe('NOT_FOUND');

    // The identifier itself may be echoed — the caller supplied it, and the
    // error's `path` is the request they made. What must never appear is
    // anything that confirms the wallet exists or says whose it is: a balance,
    // or the owning organization.
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(ORG.a);
    expect(body).not.toContain('BalanceMinor');
  });

  test("another tenant's holds are not found either", async ({ tenantB }) => {
    const response = await tenantB.get(`/v1/wallets/${walletId}/holds`);
    expect(response.status).toBe(404);
  });

  test('a transaction is visible to its two named parties and to nobody else', async ({
    tenantA,
    tenantB,
    platformAdmin,
  }) => {
    // The payer owns it.
    expect((await tenantA.get(`/v1/transactions/${transactionId}`)).status).toBe(200);

    // The payee is a named party and is entitled to it — the tenant guard
    // cannot express that, so `assertTransactionVisible` decides it explicitly.
    const payee = await tenantB.get(`/v1/transactions/${transactionId}`);
    expect(payee.status).toBe(200);
    expect((payee.body as { counterpartyOrganizationId: string }).counterpartyOrganizationId).toBe(
      ORG.b,
    );

    // A platform administrator may read any transaction; that is what makes a
    // stuck settlement diagnosable at all.
    expect((await platformAdmin.get(`/v1/transactions/${transactionId}`)).status).toBe(200);
  });

  test('a fabricated identifier is indistinguishable from another tenant’s', async ({
    tenantB,
  }) => {
    // The same 404 for "does not exist" and "is not yours" is the point: the
    // two must not be tellable apart.
    const invented = await tenantB.get('/v1/transactions/TXN_00000000000000000000000000');
    expect(invented.status).toBe(404);
    expect(errorCode(invented.body)).toBe('NOT_FOUND');
  });

  test('a tenant cannot commit another organization financially', async ({ tenantB }) => {
    const response = await tenantB.post(`/v1/transactions/${transactionId}/authorise-settlement`, {
      idempotencyKey: idempotencyKey('authz-cross-authorise'),
    });

    // The payee may *read* the transaction, but authorising settlement commits
    // the payer, and only the payer's administrators may do that (ADR-029's
    // narrowing, applied to money).
    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe('TENANT_MISMATCH');
  });

  test.describe('the oversight role reaches nothing in this service', () => {
    // CONSTRAINT (product document ch. 4, docs/09 § 9.3, docs/10 § 10.13):
    // "بدون دسترسی به جزئیات تراکنش‌های فردی". Not read-only — none.
    const closed = [
      '/v1/wallets/me',
      '/v1/transactions',
      '/v1/settlements',
      '/v1/commissions',
      '/v1/payment-intents',
      '/v1/ledger/trial-balance?currency=IRR',
    ];

    for (const path of closed) {
      test(`AUDITOR is refused GET ${path}`, async ({ auditor }) => {
        const response = await auditor.get(path);

        expect(response.status).toBe(403);
        expect(['FORBIDDEN', 'INSUFFICIENT_ROLE']).toContain(errorCode(response.body));
      });
    }

    test('AUDITOR is refused a financial write', async ({ auditor }) => {
      const response = await auditor.post('/v1/transactions', {
        idempotencyKey: idempotencyKey('auditor-write'),
        body: {
          transactionType: 'LOGISTICS',
          counterpartyOrganizationId: ORG.a,
          grossAmountMinor: '1000',
          holdFunds: false,
        },
      });

      expect(response.status).toBe(403);
    });

    test('the refusal is an authorization decision, not a failed login', async ({
      auditor,
      anonymous,
    }) => {
      // Worth separating. If the refusals above were really token failures,
      // they would pass for the wrong reason the day the realm changed — and
      // the constraint they exist to defend would be untested. The same path,
      // asked twice: no credentials is 401, valid credentials with the wrong
      // role is 403.
      expect((await anonymous.get('/v1/wallets/me')).status).toBe(401);
      expect((await auditor.get('/v1/wallets/me')).status).toBe(403);
    });
  });

  test('a settlement is not visible to an organization that is not a party', async ({
    tenantA,
    platformAdmin,
  }) => {
    // Built here rather than reused from the critical path, so this file does
    // not depend on another file's execution order.
    const key = idempotencyKey('authz-settlement');
    const created = await tenantA.post('/v1/transactions', {
      idempotencyKey: key,
      body: {
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: ORG.b,
        grossAmountMinor: '7000',
        currency: 'IRR',
        sourceType: 'E2E',
        sourceReference: key,
        holdFunds: true,
      },
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;

    await tenantA.post(`/v1/transactions/${id}/authorise-settlement`, {
      idempotencyKey: idempotencyKey('authz-settlement-authorise'),
    });
    const settled = await tenantA.post('/v1/settlements', {
      idempotencyKey: idempotencyKey('authz-settlement-settle'),
      body: { transactionId: id },
    });
    expect(settled.status).toBe(201);
    const settlementId = (settled.body as { settlementId: string }).settlementId;

    // A platform administrator is not a party. `GET /v1/settlements/:id`
    // narrows to payer and payee only, so even platform scope gets 404 here —
    // and that is the documented behaviour of that endpoint, not an accident.
    const outsider = await platformAdmin.get(`/v1/settlements/${settlementId}`);
    expect(outsider.status).toBe(404);
  });
});
