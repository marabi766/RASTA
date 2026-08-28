import { MockPaymentProvider } from './mock.provider';

/**
 * The simulated payment provider (ADR-024).
 *
 * Two properties are being asserted, and both are requirements rather than
 * conveniences:
 *
 *   **It always says it is simulated.** ADR-024 forbids any claim of a real
 *   bank connection, and a result indistinguishable from a real payment *is*
 *   such a claim.
 *
 *   **Failure is provoked, never random.** A provider that failed one call in
 *   twenty would land its failure on a different test each run and prove
 *   nothing. The request asks for the failure, so the compensation paths are
 *   reachable deterministically.
 */

const provider = new MockPaymentProvider();

const authorizeRequest = {
  paymentIntentId: 'PAY_1',
  organizationId: 'ORG-A',
  amountMinor: 10_000_000n,
  currency: 'IRR',
  idempotencyKey: 'idem-key-0001',
};

describe('disclosure', () => {
  it('names itself and admits it is simulated', () => {
    expect(provider.name).toBe('mock');
    expect(provider.simulated).toBe(true);
  });

  it('marks every result simulated, on every path', async () => {
    const authorized = await provider.authorize(authorizeRequest);
    const captured = await provider.capture({
      paymentIntentId: 'PAY_1',
      providerReference: authorized.providerReference,
      amountMinor: 10_000_000n,
      currency: 'IRR',
      idempotencyKey: 'idem-key-0001',
    });
    const failed = await provider.authorize({
      ...authorizeRequest,
      paymentIntentId: 'PAY_2',
      instrument: 'fail:INSUFFICIENT_FUNDS',
    });

    expect(authorized.simulated).toBe(true);
    expect(captured.simulated).toBe(true);
    expect(failed.simulated).toBe(true);
  });
});

describe('authorize', () => {
  it('succeeds deterministically', async () => {
    const first = await provider.authorize(authorizeRequest);
    const second = await provider.authorize(authorizeRequest);

    expect(first.outcome).toBe('AUTHORIZED');
    expect(second.outcome).toBe('AUTHORIZED');
    expect(first.providerReference).toBe(second.providerReference);
  });

  it('fails when the request asks it to, with the code it asked for', async () => {
    const result = await provider.authorize({
      ...authorizeRequest,
      instrument: 'fail:INSUFFICIENT_FUNDS',
    });

    expect(result.outcome).toBe('FAILED');
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('supplies a generic code when the directive names none', async () => {
    const result = await provider.authorize({ ...authorizeRequest, instrument: 'fail:' });
    expect(result).toMatchObject({ outcome: 'FAILED', failureCode: 'PROVIDER_DECLINED' });
  });

  it('takes the success path for an ordinary instrument reference', async () => {
    const result = await provider.authorize({ ...authorizeRequest, instrument: 'tok_abc123' });
    expect(result.outcome).toBe('AUTHORIZED');
  });
});

describe('capture', () => {
  const captureRequest = {
    paymentIntentId: 'PAY_1',
    providerReference: 'mock_PAY_1',
    amountMinor: 10_000_000n,
    currency: 'IRR',
    idempotencyKey: 'idem-key-0001',
  };

  it('captures an authorised payment', async () => {
    const result = await provider.capture(captureRequest);
    expect(result.outcome).toBe('CAPTURED');
  });

  it('fails when the reference carries a capture directive', async () => {
    // The path that matters: an authorisation that succeeds and a capture that
    // does not is exactly the case where crediting on authorise would have put
    // money in a wallet that has to be clawed back.
    const result = await provider.capture({
      ...captureRequest,
      providerReference: 'mock_PAY_1_fail-capture:ISSUER_TIMEOUT',
    });

    expect(result).toMatchObject({ outcome: 'FAILED', failureCode: 'ISSUER_TIMEOUT' });
  });
});

describe('refund', () => {
  const refundRequest = {
    paymentIntentId: 'PAY_1',
    providerReference: 'mock_PAY_1',
    amountMinor: 10_000_000n,
    currency: 'IRR',
    idempotencyKey: 'idem-key-0001:refund',
    reason: 'cancelled',
  };

  it('refunds a captured payment', async () => {
    const result = await provider.refund(refundRequest);
    expect(result.outcome).toBe('REFUNDED');
  });

  it('fails when the reference carries a refund directive', async () => {
    const result = await provider.refund({
      ...refundRequest,
      providerReference: 'mock_PAY_1_fail-refund:NOT_PERMITTED',
    });
    expect(result).toMatchObject({ outcome: 'FAILED', failureCode: 'NOT_PERMITTED' });
  });
});

describe('getStatus', () => {
  it('reports what it last did with a reference', async () => {
    const fresh = new MockPaymentProvider();
    await fresh.authorize({ ...authorizeRequest, paymentIntentId: 'PAY_STATUS' });
    expect(await fresh.getStatus('mock_PAY_STATUS')).toBe('AUTHORIZED');
  });

  it('answers UNKNOWN for a reference it never issued', async () => {
    // The honest answer, and the reason nothing reconciles against this
    // provider: it keeps no durable records, because it is not a real one. The
    // durable record is `payment_intent` in this service's own database.
    expect(await new MockPaymentProvider().getStatus('mock_SOMETHING_ELSE')).toBe('UNKNOWN');
  });
});

describe('simulated latency', () => {
  it('is zero by default, so tests are fast', async () => {
    const started = Date.now();
    await provider.authorize({ ...authorizeRequest, paymentIntentId: 'PAY_FAST' });
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('is a fixed delay when configured, never a random one', async () => {
    // A random delay makes a demo look realistic and a test suite unreliable.
    const slow = new MockPaymentProvider(40);
    const started = Date.now();
    await slow.authorize({ ...authorizeRequest, paymentIntentId: 'PAY_SLOW' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });
});
