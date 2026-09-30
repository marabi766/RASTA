import { MockPaymentProvider } from './mock.provider';
import { PROVIDER_TIMEOUT, TimedPaymentProvider } from './provider-timeout';
import type { PaymentProvider } from './provider';

/**
 * Every provider call has a deadline (ADR-064 step B2). None did: a provider
 * that hung took the request with it, and the reconciler's grace period had
 * nothing to be longer than. A call past its deadline is an *unknown*
 * outcome — the provider may still act on it — which the callers already
 * treat as such (B0's markers); the reconciler then asks.
 */
describe('TimedPaymentProvider', () => {
  const never = () => new Promise<never>(() => undefined);
  const hanging: PaymentProvider = {
    name: 'hanging',
    simulated: true,
    authoritativeAbsence: false,
    authorize: never,
    capture: never,
    refund: never,
    getStatus: never,
    getRefundStatus: never,
  };

  it('keeps the name and the simulated flag of what it wraps', () => {
    const timed = new TimedPaymentProvider(new MockPaymentProvider(), 1000);
    expect(timed.name).toBe('mock');
    expect(timed.simulated).toBe(true);
  });

  it('passes answers through untouched', async () => {
    const timed = new TimedPaymentProvider(new MockPaymentProvider(), 1000);
    const auth = await timed.authorize({
      paymentIntentId: 'PAY_T',
      organizationId: 'ORG-T',
      amountMinor: 100n,
      currency: 'IRR',
      idempotencyKey: 'KEY-T',
    });
    expect(auth).toMatchObject({ outcome: 'AUTHORIZED', simulated: true });
    expect(await timed.getStatus(auth.providerReference)).toBe('AUTHORIZED');
  });

  it.each([
    ['refund', (p: PaymentProvider) => p.refund({} as never)],
    ['getRefundStatus', (p: PaymentProvider) => p.getRefundStatus({} as never)],
  ])('fails %s past its deadline with a closed code, never a guess', async (_name, call) => {
    const timed = new TimedPaymentProvider(hanging, 20);
    await expect(call(timed)).rejects.toMatchObject({ code: PROVIDER_TIMEOUT });
  });

  it('puts no deadline on the top-up calls until step C can recover them (Codex on #164, HIGH 1)', async () => {
    // The stated configuration: mock latency 500 ms, timeout 100 ms. A
    // timed-out authorize left the intent CREATED, the provider authorized
    // it anyway, and nothing recovered it: its amount kept reserving the
    // wallet's headroom. Authorize, capture and getStatus pass through.
    const timed = new TimedPaymentProvider(new MockPaymentProvider(500), 100);
    const auth = await timed.authorize({
      paymentIntentId: 'PAY_SLOW_TOPUP',
      organizationId: 'ORG-T',
      amountMinor: 100n,
      currency: 'IRR',
      idempotencyKey: 'KEY-SLOW',
    });
    expect(auth.outcome).toBe('AUTHORIZED');
    const capture = await timed.capture({
      paymentIntentId: 'PAY_SLOW_TOPUP',
      providerReference: auth.providerReference,
      amountMinor: 100n,
      currency: 'IRR',
      idempotencyKey: 'KEY-SLOW',
    });
    expect(capture.outcome).toBe('CAPTURED');
    expect(await timed.getStatus(auth.providerReference)).toBe('CAPTURED');

    // The refund side keeps its deadline.
    await expect(
      timed.refund({
        paymentIntentId: 'PAY_SLOW_TOPUP',
        providerReference: auth.providerReference,
        amountMinor: 100n,
        currency: 'IRR',
        idempotencyKey: 'KEY-SLOW:refund',
        reason: 'the suite refunds',
      }),
    ).rejects.toMatchObject({ code: PROVIDER_TIMEOUT });
  });

  it('passes the absence capability through', () => {
    expect(new TimedPaymentProvider(new MockPaymentProvider(), 1000).authoritativeAbsence).toBe(
      false,
    );
    expect(
      new TimedPaymentProvider({ ...hanging, authoritativeAbsence: true }, 1000)
        .authoritativeAbsence,
    ).toBe(true);
  });

  it('passes a provider failure through as it came', async () => {
    const failing: PaymentProvider = {
      ...hanging,
      refund: () => Promise.reject(new Error('connection reset')),
    };
    await expect(new TimedPaymentProvider(failing, 1000).refund({} as never)).rejects.toThrow(
      'connection reset',
    );
  });
});
