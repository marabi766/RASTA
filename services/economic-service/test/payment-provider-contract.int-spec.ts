import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { admin, apiTenant, bearer, startApi, type ApiHarness } from './api-helpers';
import { cleanup } from './helpers';
import type {
  AuthorizeRequest,
  AuthorizeResult,
  CaptureRequest,
  CaptureResult,
  PaymentProvider,
  ProviderPaymentStatus,
  RefundResult,
} from '../src/payment/provider';

/**
 * What this service does when the payment provider behaves badly.
 *
 * `MockPaymentProvider` is a well-behaved provider: it always attaches a
 * failure code, always returns a reference, and never contradicts itself. That
 * is right for a provider used in demos, and it means a whole class of the
 * service's defensive handling is unreachable through it — the branches that
 * decide what a caller is told when a provider refuses *without saying why*.
 *
 * `failureCode` is optional on `AuthorizeResult`, `CaptureResult` and
 * `RefundResult`. A real provider omitting it is within the contract, so the
 * question "what does the buyer see" has a real answer that ought to be
 * asserted rather than inferred.
 *
 * ## What is substituted, and what is not
 *
 * Only the provider — the one genuinely external thing here, a network
 * boundary to somebody else's system, and an interface precisely so it can be
 * replaced (ADR-024). Everything behind it stays real: the wallet row locks,
 * the ledger triggers, `ck_wallet_balances`, the outbox, the transaction.
 * Nothing financial is mocked.
 *
 * Nothing in this file changes what the service does. Each test names a path
 * that already existed and had never been executed.
 */

/** A provider that refuses without ever saying why. */
class SilentlyRefusingProvider implements PaymentProvider {
  readonly name = 'silent-test-double';
  readonly simulated = true;

  constructor(private readonly refuse: 'authorize' | 'capture' | 'refund') {}

  async authorize(request: AuthorizeRequest): Promise<AuthorizeResult> {
    if (this.refuse === 'authorize') {
      // FAILED with no `failureCode`. Permitted by the interface.
      return {
        outcome: 'FAILED',
        providerReference: `ref-${request.paymentIntentId}`,
        simulated: true,
      };
    }
    return {
      outcome: 'AUTHORIZED',
      providerReference: `ref-${request.paymentIntentId}`,
      simulated: true,
    };
  }

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    if (this.refuse === 'capture') {
      return { outcome: 'FAILED', providerReference: request.providerReference, simulated: true };
    }
    return { outcome: 'CAPTURED', providerReference: request.providerReference, simulated: true };
  }

  async refund(): Promise<RefundResult> {
    if (this.refuse === 'refund') {
      return { outcome: 'FAILED', providerReference: 'ref', simulated: true };
    }
    return { outcome: 'REFUNDED', providerReference: 'ref', simulated: true };
  }

  async getStatus(): Promise<ProviderPaymentStatus> {
    return 'UNKNOWN';
  }
}

/** A provider that moves real money, so the disclosure must say so. */
class LiveProvider implements PaymentProvider {
  readonly name = 'live-test-double';
  readonly simulated = false;

  async authorize(request: AuthorizeRequest): Promise<AuthorizeResult> {
    return {
      outcome: 'AUTHORIZED',
      providerReference: `live-${request.paymentIntentId}`,
      simulated: false,
    };
  }
  async capture(request: CaptureRequest): Promise<CaptureResult> {
    return { outcome: 'CAPTURED', providerReference: request.providerReference, simulated: false };
  }
  async refund(): Promise<RefundResult> {
    return { outcome: 'REFUNDED', providerReference: 'live', simulated: false };
  }
  async getStatus(): Promise<ProviderPaymentStatus> {
    return 'UNKNOWN';
  }
}

/** The caller's own wallet, opened on first read. */
async function walletOf(http: Server, org: string) {
  const response = await request(http)
    .get('/v1/wallets/me')
    .set('authorization', `Bearer ${admin(org)}`)
    .expect(200);
  return response.body as { id: string; availableBalanceMinor: string; ledgerBalanceMinor: string };
}

/**
 * A platform administrator who is also a member of the tenant.
 *
 * What an operator resolving a stuck payment actually looks like, and the only
 * scope permitted to refund (the owning organization's own admin is refused).
 */
function platformAdminFor(organizationId: string): string {
  return bearer({
    sub: `sub-platform-${organizationId}`,
    rastaUserId: 'USR-PAYCONTRACT-PLATFORM',
    organizationId,
    organizationIds: [organizationId],
    roles: ['UNION_ADMIN'],
  });
}

async function topUp(http: Server, org: string, body: Record<string, unknown> = {}) {
  const wallet = await walletOf(http, org);
  return request(http)
    .post(`/v1/wallets/${wallet.id}/top-up`)
    .set('authorization', `Bearer ${admin(org)}`)
    .set('idempotency-key', `PAYCONTRACT-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`)
    .send({ amountMinor: '500000', ...body });
}

describe('a payment provider that refuses without a reason', () => {
  describe('at authorisation', () => {
    let harness: ApiHarness;
    let http: Server;
    const org = apiTenant('PAYSILENT-AUTH');

    beforeAll(async () => {
      harness = await startApi({ paymentProvider: new SilentlyRefusingProvider('authorize') });
      http = harness.app.getHttpServer() as Server;
    });

    afterAll(async () => {
      await cleanup(harness.prisma, [org]);
      await harness.close();
    });

    it('reports a decline rather than an empty reason', async () => {
      // The caller has to be told *something* actionable. An undefined code
      // reaching the response would render as a blank failure in a UI and be
      // stored as a blank failure on the intent, which is indistinguishable
      // from "we did not look".
      const response = await topUp(http, org, {});

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('FAILED');
      expect(response.body.failureReason).toBe('PROVIDER_DECLINED');
    });

    it('moves no money and opens no journal when the provider refuses', async () => {
      // The assertion that matters more than the code. A failed authorisation
      // must leave the ledger exactly as it was: a top-up that never happened
      // has nothing to post.
      await topUp(http, org, {});

      const wallet = await walletOf(http, org);
      expect(wallet.availableBalanceMinor).toBe('0');

      const journals = await runUnscoped('the suite counts journals for the refused top-up', () =>
        harness.prisma.client.journal.count({ where: { organizationId: org } }),
      );
      expect(journals).toBe(0);
    });

    it('records the failure on the intent, so an operator can see it happened', async () => {
      // Refused is not the same as never attempted. The intent is the durable
      // record, and it must survive the refusal.
      const response = await topUp(http, org, {});
      const intentId = response.body.paymentIntentId as string;

      const intent = await runUnscoped('the suite reads the refused intent', () =>
        harness.prisma.client.paymentIntent.findUniqueOrThrow({ where: { id: intentId } }),
      );
      expect(intent.status).toBe('FAILED');
      expect(intent.failureReason).toBe('PROVIDER_DECLINED');
    });
  });

  describe('at capture, after authorising', () => {
    let harness: ApiHarness;
    let http: Server;
    const org = apiTenant('PAYSILENT-CAP');

    beforeAll(async () => {
      harness = await startApi({ paymentProvider: new SilentlyRefusingProvider('capture') });
      http = harness.app.getHttpServer() as Server;
    });

    afterAll(async () => {
      await cleanup(harness.prisma, [org]);
      await harness.close();
    });

    it('distinguishes a declined capture from a declined authorisation', async () => {
      // The two failures mean different things operationally: the money was
      // never promised, versus it was promised and then not taken. Collapsing
      // them into one code loses the distinction an operator needs.
      const response = await topUp(http, org, {});

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('FAILED');
      expect(response.body.failureReason).toBe('CAPTURE_DECLINED');
    });

    it('credits nothing, because capture is what makes the money real', async () => {
      await topUp(http, org, {});

      const wallet = await walletOf(http, org);
      expect(wallet.availableBalanceMinor).toBe('0');
    });
  });

  describe('at refund, after a captured top-up', () => {
    let harness: ApiHarness;
    let http: Server;
    const org = apiTenant('PAYSILENT-REF');

    beforeAll(async () => {
      harness = await startApi({ paymentProvider: new SilentlyRefusingProvider('refund') });
      http = harness.app.getHttpServer() as Server;
    });

    afterAll(async () => {
      await cleanup(harness.prisma, [org]);
      await harness.close();
    });

    it('refuses the refund and leaves the captured funds exactly where they are', async () => {
      // The important half is the second one. A refund the provider rejected
      // must not reverse the ledger locally, or the books would say the money
      // went back while the provider still holds it.
      const captured = await topUp(http, org, {});
      expect(captured.status).toBe(201);
      expect(captured.body.status).toBe('CAPTURED');

      const before = await walletOf(http, org);
      expect(before.availableBalanceMinor).toBe('500000');

      const refund = await request(http)
        .post(`/v1/payment-intents/${captured.body.paymentIntentId}/refund`)
        .set('authorization', `Bearer ${platformAdminFor(org)}`)
        .set('idempotency-key', `PAYCONTRACT-REFUND-${Date.now()}`)
        .send({ reason: 'the buyer changed their mind' });

      expect(refund.status).toBe(422);
      expect(refund.body.code).toBe('BUSINESS_RULE_VIOLATION');

      const after = await walletOf(http, org);
      expect(after.availableBalanceMinor).toBe('500000');

      // And the intent is still CAPTURED: a refused refund is not a state
      // change, and recording one would let a second refund attempt be
      // rejected as "already refunded".
      const intent = await runUnscoped('the suite reads the intent after a refused refund', () =>
        harness.prisma.client.paymentIntent.findUniqueOrThrow({
          where: { id: captured.body.paymentIntentId as string },
        }),
      );
      expect(intent.status).toBe('CAPTURED');
    });
  });
});

describe('a payment provider that moves real money', () => {
  let harness: ApiHarness;
  let http: Server;
  const org = apiTenant('PAYLIVE');

  beforeAll(async () => {
    harness = await startApi({ paymentProvider: new LiveProvider() });
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [org]);
    await harness.close();
  });

  it('says so, instead of repeating the simulated notice', async () => {
    // ADR-024 forbids claiming a bank connection that does not exist. The
    // inverse matters just as much and is the branch nothing had executed:
    // a service wired to a live provider must not keep telling everyone its
    // payments are simulated. Silence and a stale notice are both claims.
    const response = await request(http)
      .get('/v1/wallets/provider')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);

    expect(response.body.simulated).toBe(false);
    expect(response.body.provider).toBe('live-test-double');
    expect(response.body.notice).toBe('Live payment provider.');
    expect(response.body.notice).not.toMatch(/simulated/i);
  });
});
