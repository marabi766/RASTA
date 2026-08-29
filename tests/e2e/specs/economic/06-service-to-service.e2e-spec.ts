import { test, expect, errorCode, idempotencyKey, minor } from '../../src/api';
import { ORG } from '../../src/env';
import { mintInternalToken } from '../../src/internal';

/**
 * Scenario 6 — the order saga's activity path, as a service (ADR-035).
 *
 * `docs/08` § 8.6 says `OrderSagaWorkflow` reaches this domain by calling
 * `placeHold()` and `settle()` as **activities**, not by publishing events.
 * Until Q-28 was answered that path did not work at all: the guard resolved no
 * tenant for a service call, so every one of them died on the first
 * tenant-scoped read.
 *
 * This runs it for real — a token signed the way `marketplace-service` would
 * sign one, sent to a running economic-service through its own port, against a
 * real PostgreSQL and a real Kafka.
 *
 * ## Why these calls do not go through the gateway
 *
 * They are not supposed to. The gateway is the front door for **users**: it
 * mints `RELAY` tokens and never `SERVICE` ones, precisely so that the
 * component exposed to outside traffic cannot forge a service identity
 * (D-007). A service-to-service activity call reaches the service directly on
 * the internal network, which is the topology `docs/06` § 6.12 describes.
 * Sending these through the gateway would be testing a path the platform does
 * not have.
 */
test.describe.serial('the order saga as a service', () => {
  const service = 'marketplace-service';

  /** A token signed for one organization, addressed to economic-service. */
  const tokenFor = (organizationId?: string) =>
    mintInternalToken(service, organizationId ? { organizationId } : {});

  test('is served the organization its token was signed for', async ({ tenantA, config }) => {
    const token = await tokenFor(ORG.a);

    const response = await tenantA.get('/v1/wallets/me', {
      baseUrl: config.economicUrl,
      internalToken: token,
    });

    expect(response.status).toBe(200);
    expect((response.body as { organizationId: string }).organizationId).toBe(ORG.a);
  });

  test('is refused when its token carries no organization — 403, not 500', async ({
    tenantA,
    config,
  }) => {
    // The defect Q-28 recorded, now closed. This used to be an unhandled error
    // reported as `500 INTERNAL_ERROR`, which made a deliberate security rule
    // look like a fault and sent operators hunting for a bug that was not
    // there.
    const response = await tenantA.get('/v1/wallets/me', {
      baseUrl: config.economicUrl,
      internalToken: await tokenFor(),
    });

    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe('SERVICE_TENANT_CONTEXT_INVALID');
    // And it says nothing about which check failed, or about the token.
    expect(JSON.stringify(response.body)).not.toContain('MISSING_CLAIM');
    expect(JSON.stringify(response.body)).not.toContain(service);
  });

  test('cannot be talked into another tenant by a forged header', async ({ tenantA, config }) => {
    // A token legitimately signed for organization A, asking — in an unsigned
    // header anything on the network could write — to act for organization B.
    const response = await tenantA.get('/v1/wallets/me', {
      baseUrl: config.economicUrl,
      internalToken: await tokenFor(ORG.a),
      organizationId: ORG.b,
    });

    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe('SERVICE_TENANT_CONTEXT_INVALID');
    // Nothing about the other organization comes back — not a balance, not an
    // id, not a confirmation that it exists.
    expect(JSON.stringify(response.body)).not.toContain(ORG.b);
  });

  test('accepts a header that agrees with the signature', async ({ tenantA, config }) => {
    const response = await tenantA.get('/v1/wallets/me', {
      baseUrl: config.economicUrl,
      internalToken: await tokenFor(ORG.a),
      organizationId: ORG.a,
    });

    expect(response.status).toBe(200);
  });

  test('a relay token never buys service authority, tenant claim or not', async ({
    tenantA,
    config,
  }) => {
    // The gateway mints these. If one satisfied `@AllowService`, the component
    // most exposed to the outside would be the one able to impersonate a
    // service — and signing a tenant into it must not change that.
    for (const organizationId of [undefined, ORG.a]) {
      const response = await tenantA.get('/v1/wallets/me', {
        baseUrl: config.economicUrl,
        internalToken: await mintInternalToken('api-gateway', {
          purpose: 'RELAY',
          ...(organizationId ? { organizationId } : {}),
        }),
      });

      expect(response.status).toBe(401);
    }
  });

  test('a token addressed to another service is refused', async ({ tenantA, config }) => {
    // Scoped to one audience, so a token leaked from notification-service
    // cannot be replayed here (ADR-020).
    const response = await tenantA.get('/v1/wallets/me', {
      baseUrl: config.economicUrl,
      internalToken: await mintInternalToken(service, {
        organizationId: ORG.a,
        targetService: 'notification-service',
      }),
    });

    expect(response.status).toBe(401);
  });

  test('an expired token is refused', async ({ tenantA, config }) => {
    const response = await tenantA.get('/v1/wallets/me', {
      baseUrl: config.economicUrl,
      internalToken: await mintInternalToken(service, {
        organizationId: ORG.a,
        ttlSeconds: -120,
      }),
    });

    expect(response.status).toBe(401);
  });

  test('an unapproved service is refused even with a valid signed tenant', async ({
    tenantA,
    config,
  }) => {
    const response = await tenantA.get('/v1/wallets/me', {
      baseUrl: config.economicUrl,
      internalToken: await mintInternalToken('notification-service', { organizationId: ORG.a }),
    });

    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe('FORBIDDEN');
  });

  test('runs hold → authorise → settle, and moves the money', async ({ tenantA, config }) => {
    const token = await tokenFor(ORG.a);
    const reference = idempotencyKey('saga-order');

    const before = await tenantA.get('/v1/wallets/me', {
      baseUrl: config.economicUrl,
      internalToken: token,
    });
    // Deltas, not absolutes. `ORG-DEH-0001` is the tenant every other
    // scenario in this suite also uses, so it legitimately carries holds from
    // them — a disputed transaction in 04, a funded hold in 05. Asserting an
    // absolute pending balance here would be asserting the other files'
    // execution order.
    const opening = before.body as {
      availableBalanceMinor: string;
      pendingBalanceMinor: string;
    };
    const availableBefore = minor(opening.availableBalanceMinor);
    const pendingBefore = minor(opening.pendingBalanceMinor);

    // Activity one: the obligation and the escrow, in one call.
    const created = await tenantA.post('/v1/transactions', {
      baseUrl: config.economicUrl,
      internalToken: token,
      idempotencyKey: reference,
      body: {
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: ORG.b,
        grossAmountMinor: '250000',
        currency: 'IRR',
        sourceType: 'ORDER',
        sourceReference: reference,
        holdFunds: true,
      },
    });

    expect(created.status).toBe(201);
    const transaction = created.body as { id: string; status: string; createdBy: string };
    expect(transaction.status).toBe('HELD');
    // There is no user behind a workflow activity, so the row names the
    // service. An empty actor on a financial record leaves an auditor unable
    // to say who committed the organization (AGENTS.md S-06).
    expect(transaction.createdBy).toBe('economic-service');

    // Activity two: receipt confirmed, then pay.
    const authorised = await tenantA.post(
      `/v1/transactions/${transaction.id}/authorise-settlement`,
      {
        baseUrl: config.economicUrl,
        internalToken: token,
        idempotencyKey: idempotencyKey('saga-authorise'),
      },
    );
    expect(authorised.status).toBe(200);

    const settled = await tenantA.post('/v1/settlements', {
      baseUrl: config.economicUrl,
      internalToken: token,
      idempotencyKey: idempotencyKey('saga-settle'),
      body: { transactionId: transaction.id },
    });
    expect(settled.status).toBe(201);
    expect(minor((settled.body as { grossAmountMinor: string }).grossAmountMinor)).toBe(250_000n);

    // The payer really paid: escrow left, and what was spendable is unchanged
    // because it was committed at hold time.
    const after = await tenantA.get('/v1/wallets/me', {
      baseUrl: config.economicUrl,
      internalToken: token,
    });
    const wallet = after.body as {
      availableBalanceMinor: string;
      pendingBalanceMinor: string;
    };
    expect(minor(wallet.availableBalanceMinor)).toBe(availableBefore - 250_000n);
    // The escrow this saga took is gone again: settled, not left held.
    expect(minor(wallet.pendingBalanceMinor)).toBe(pendingBefore);
  });

  test('a retried activity has no second financial effect', async ({ tenantA, config }) => {
    // A workflow retries an activity. The same signed token and the same key
    // must return the first response, not take the money twice.
    const token = await tokenFor(ORG.a);
    const key = idempotencyKey('saga-retry');
    const body = {
      transactionType: 'MARKETPLACE_ORDER',
      counterpartyOrganizationId: ORG.b,
      grossAmountMinor: '11000',
      currency: 'IRR',
      sourceType: 'ORDER',
      sourceReference: key,
      holdFunds: true,
    };

    const first = await tenantA.post('/v1/transactions', {
      baseUrl: config.economicUrl,
      internalToken: token,
      idempotencyKey: key,
      body,
    });
    expect(first.status).toBe(201);

    const held = await tenantA.get('/v1/wallets/me', {
      baseUrl: config.economicUrl,
      internalToken: token,
    });

    const replay = await tenantA.post('/v1/transactions', {
      baseUrl: config.economicUrl,
      internalToken: token,
      idempotencyKey: key,
      body,
    });
    expect(replay.status).toBe(201);
    expect((replay.body as { id: string }).id).toBe((first.body as { id: string }).id);

    const after = await tenantA.get('/v1/wallets/me', {
      baseUrl: config.economicUrl,
      internalToken: token,
    });
    expect(after.body).toEqual(held.body);
  });
});
