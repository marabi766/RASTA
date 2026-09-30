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
    ['authorize', (p: PaymentProvider) => p.authorize({} as never)],
    ['capture', (p: PaymentProvider) => p.capture({} as never)],
    ['refund', (p: PaymentProvider) => p.refund({} as never)],
    ['getStatus', (p: PaymentProvider) => p.getStatus('mock_X')],
    ['getRefundStatus', (p: PaymentProvider) => p.getRefundStatus({} as never)],
  ])('fails %s past its deadline with a closed code, never a guess', async (_name, call) => {
    const timed = new TimedPaymentProvider(hanging, 20);
    await expect(call(timed)).rejects.toMatchObject({ code: PROVIDER_TIMEOUT });
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
